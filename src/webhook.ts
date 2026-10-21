import "dotenv/config";

import { randomBytes } from "node:crypto";

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { encerrarBanco } from "./banco.js";

import { IAClaude, NOME_DA_ETAPA, mensagemSemInformacao, textoDaMidia, type MotivoEncaminhamentoAutomatico } from "./iaClaude.js";

import { descreverErro, mascararChatId, valorSeguro, wamidSeguro } from "./logSeguro.js";

import { agendarRetencao } from "./retencao.js";

import { lerAberturaManualAtiva, lerFechamentos } from "./persistenciaFechamentos.js";

import {
  motivoDaFalhaEnvio,
  registrarEnvioAceito,
  registrarFalhaEnvio,
  registrarMensagemDescartada,
} from "./alertaEnvio.js";

import type { IA } from "./ia.js";

import {
  ehChatMeta,
  listarStatusesMeta,
  normalizarMensagensMeta,
  processarPayloadMeta,
  verificarAssinaturaMeta,
  verificarDesafioMeta,
  type MetaStatus,
  type MetaWebhookPayload,
} from "./metaWebhook.js";

import {
  descreverDestinoMeta,
  enviarTextoMeta,
  mascararTelefone,
  metaEnvioAtivo,
  obterChatIdPorWamid,
  type ResultadoEnvioMeta,
} from "./metaEnvio.js";

import {
  AVISO_ENCAMINHAMENTO_FORA_DO_HORARIO,
  mensagemLojaFechada,
  chavePeriodoFechado,
  dataLocal,
  aberturaManualRegistrada,
  definirAberturaManual,
  definirDiasFechados,
  horarioDaLoja,
  mesclarDiasFechados,
  lojaAberta,
  fimDoDiaLocal,
} from "./horarioFuncionamento.js";

import {
  definirAoAssumirAtendimento,
  definirEnvioAoCliente,
  enviarResumoTelegram,
  processarUpdateTelegram,
  reenviarPendenciasRecuperadas,
  redefinirEstadoTelegramParaTestes,
  reenviarResumosTelegramPendentes,
  regravarPendenciasBanco,
  registrarMenuComandos,
  restaurarAberturaManual,
  verificarFimAberturaManual,
  restaurarEstadoTelegram,
  segredoWebhookTelegramValido,
  situacaoResumoTelegram,
  telegramConfigurado,
  apagarResumosAssumidos,
  repassarMensagemAoVendedor,
  verificarLembretesSemAssumir,
  type ResultadoEnvioCliente,
  type TelegramUpdate,
} from "./telegramBot.js";

import { lerTelegramResumoTtlHoras } from "./configTelegram.js";

import {
  lerDadosRecuperacao,
  type ConversaRecuperada,
  type DadosRecuperacao,
  type ResumoRecuperado,
} from "./persistenciaRecuperacao.js";

import {
  idRegistravel,
  lerEventosPendentes,
  marcarEventosProcessados,
  registrarEventoRecebido,
  type CanalEvento,
} from "./eventosProcessados.js";

import {
  registrarAtividadeAtendimento,
  registrarEncerramentoAtendimento,
  registrarMensagemProcessada,
  type MensagemEspelho,
} from "./persistenciaAtendimento.js";

import type {
  Cliente,
  EstadoTriagem,
  MidiaRecebida,
  ResultadoIA,
  StatusAtendimento,
} from "./tipos.js";

/*
 * Limite máximo do corpo recebido pelo webhook.
 */
const MAX_BODY_BYTES = 1_000_000;

/*
 * Porta do backend.
 */
const PORT = Number(process.env.PORT ?? 3000);

/*
 * Endereço em que o backend escuta (HOST). Sem HOST: todas as
 * interfaces, como antes. Produção: HOST=127.0.0.1 (o proxy HTTPS
 * fica na frente; ver deploy/README.md).
 */
function hostDeEscuta(): string | undefined {
  const host = (process.env.HOST ?? "").trim();

  return host === "" ? undefined : host;
}

/*
 * Depois de 20 minutos sem mensagens,
 * o atendimento é encerrado.
 */
const INATIVIDADE_MS = 20 * 60 * 1000;

/*
 * Intervalo usado para verificar
 * atendimentos inativos.
 */
const VERIFICACAO_INATIVIDADE_MS = 30_000;

/*
 * Inatividade nunca perde cliente: sem resposta à pergunta das
 * observações, o atendimento vai ao vendedor depois deste tempo...
 */
export const ENCAMINHAR_SEM_OBSERVACOES_MS = 3 * 60 * 1000;

/*
 * ...e, em qualquer outra etapa, com nome ou produto, depois deste (o
 * resumo sai com "⚠️ Cliente parou de responder na etapa: ...").
 */
export const ENCAMINHAR_CLIENTE_PAROU_MS = 10 * 60 * 1000;

/*
 * Só mídia (imagem, documento, áudio...) e nenhum texto depois do aviso
 * que pede o texto: vai ao vendedor depois deste tempo.
 */
export const ENCAMINHAR_MIDIA_SEM_TEXTO_MS = 3 * 60 * 1000;

/*
 * Atendimento já encaminhado (HUMANO, assumido ou não) fica ativo até o
 * fim deste dia depois do encaminhamento (1 = fim do dia seguinte, em
 * Belém), não 20 min: o cliente que volta a escrever fala com o
 * vendedor (a mensagem é repassada), sem triagem nova nem resumo novo.
 */
export const DIAS_ATENDIMENTO_ENCAMINHADO = 1;

/*
 * Mensagem do cliente depois do encaminhamento, sem ninguém ter
 * assumido: uma resposta por atendimento.
 */
export const MENSAGEM_JA_ENCAMINHADO = "Seu pedido já está com a nossa equipe de vendas. Um vendedor vai te chamar assim que possível.";

export const MENSAGEM_JA_ENCAMINHADO_FECHADA = "Seu pedido já está com a nossa equipe de vendas. Um vendedor vai te chamar no próximo horário de atendimento.";

/**
 * O que a mensagem do cliente traz depois do encaminhamento: o texto, ou
 * a legenda de uma mídia; null = nada para o vendedor ("ok", "tá bom",
 * emoji sozinho, mídia sem legenda útil).
 */
function conteudoDepoisDoEncaminhamento(texto: string, midia: MidiaRecebida | null): string | null {
  const bruto = midia ? (midia.legenda ?? "") : texto;

  const linhas = bruto.split("\n").map((linha) => linha.trim()).filter((linha) => linha !== "");

  return linhas.length === 0 || linhas.every((linha) => mensagemSemInformacao(linha)) ? null : bruto.trim();
}

/*
 * Garante que mensagens recebidas do mesmo
 * cliente sejam processadas em ordem.
 */
const conversationQueues = new Map<string, Promise<void>>();

/*
 * Cada atendimento ativo possui seu próprio estado.
 */
type Conversa = {
  cliente: Cliente;

  ia: IA;

  /*
   * ID interno.
   *
   * Não aparece para o vendedor.
   */
  atendimentoId: string;

  /*
   * Um vendedor assumiu pelo Telegram?
   * (A IA não responde mais essa conversa.)
   */
  vendedorAssumiu: boolean;

  /*
   * Última atividade do atendimento.
   */
  ultimaMensagemEm: number;

  /*
   * Último instante dado a uma mensagem do espelho
   * (mantém ENTRADA/SAIDA em ordem estrita no banco).
   */
  ultimoInstanteEspelho: number;

  /*
   * O grupo já foi avisado de que uma resposta não chegou
   * a este cliente? (No máximo um aviso por atendimento.)
   */
  avisoFalhaEnvio: boolean;

  /*
   * O cliente já recebeu "Seu atendimento já foi passado para um
   * vendedor" (uma vez por atendimento).
   */
  avisoJaEncaminhado: boolean;

  /*
   * Quando o atendimento foi encaminhado (HUMANO); null = em triagem.
   */
  encaminhadoEm: number | null;
};

/*
 * Conversas atualmente ativas.
 *
 * A chave é o chatId do WhatsApp.
 */
const conversas = new Map<string, Conversa>();

/*
 * Aviso de loja fechada já enviado por chatId.
 *
 * O valor é a chave do período fechado
 * (data da próxima abertura), para avisar
 * uma única vez por período.
 */
const avisosLojaFechada = new Map<string, string>();

/*
 * Mensagem recebida, no formato interno do núcleo de
 * atendimento. A Meta é convertida para ele em
 * normalizarMensagensMeta (metaWebhook.ts).
 */
export type EventoMensagem = {
  event?: string;

  /*
   * ID externo da mensagem (wamid da Meta).
   */
  idempotencyKey?: string;

  data?: {
    id?: string;

    /*
     * meta:<phone_number_id>:<wa_id>
     */
    chatId?: string;

    from?: string;

    body?: string;

    type?: string;

    /*
     * Timestamp real da mensagem (Unix time em segundos).
     */
    timestamp?: number | string;

    /*
     * wa_id do cliente.
     */
    senderPhone?: string;

    /*
     * Áudio, imagem, vídeo, documento, figurinha, localização ou
     * contato (B7), com a legenda, se houver.
     */
    midia?: MidiaRecebida;
  };
};

/**
 * Gera um ID curto para controle interno.
 */
function gerarAtendimentoId(): string {
  /*
   * ATD- + 10 hexadecimais (40 bits): colisão de codigo
   * praticamente impossível.
   */
  return "ATD-" + randomBytes(5).toString("hex").toUpperCase();
}

/**
 * Responde JSON.
 */
function responderJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;

  response.setHeader("Content-Type", "application/json; charset=utf-8");

  response.end(JSON.stringify(body));
}

/**
 * Lê o corpo da requisição.
 */
function lerCorpo(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    let totalBytes = 0;

    request.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;

      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error("Corpo da requisição excedeu o limite."));

        request.destroy();

        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    request.on("error", reject);
  });
}

/**
 * Normaliza telefone.
 *
 * Exemplo:
 * +55 (00) 90000-0000
 *
 * vira:
 * 5500900000000
 */
function normalizarTelefone(telefone?: string): string {
  if (typeof telefone !== "string" || telefone.trim() === "") {
    return "";
  }

  return telefone.replace(/\D/g, "");
}

/**
 * Lista somente os NOMES dos campos preenchidos
 * do resumo, para logs sem dados pessoais.
 */
function camposPreenchidos(resumo: Cliente["resumo"]): string {
  const campos = Object.entries(resumo)
    .filter(
      ([campo, valor]) =>
        campo !== "telefone" &&
        typeof valor === "string" &&
        valor.trim() !== "" &&
        valor !== "Não informado",
    )
    .map(([campo]) => campo);

  return campos.length > 0 ? campos.join(", ") : "nenhum";
}

/**
 * Converte um timestamp para milissegundos.
 */
function timestampParaMs(valor: unknown): number | null {
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) {
      return null;
    }

    /*
     * Já está em milissegundos.
     */
    if (valor > 1_000_000_000_000) {
      return valor;
    }

    /*
     * Está em Unix time
     * em segundos.
     */
    return valor * 1000;
  }

  if (typeof valor === "string") {
    const numero = Number(valor);

    if (Number.isFinite(numero)) {
      return timestampParaMs(numero);
    }

    const data = Date.parse(valor);

    if (!Number.isNaN(data)) {
      return data;
    }
  }

  return null;
}

/**
 * Obtém o momento REAL em que a mensagem
 * aconteceu (data.timestamp).
 */
function obterMomentoMensagem(payload: EventoMensagem): number | null {
  return timestampParaMs(payload.data?.timestamp);
}

/**
 * Verifica se a mensagem possui
 * mais de 20 minutos.
 */
function mensagemComMaisDe20Minutos(payload: EventoMensagem): boolean {
  const momento = obterMomentoMensagem(payload);

  if (momento === null) {
    return true;
  }

  const idade = Date.now() - momento;

  return idade >= INATIVIDADE_MS;
}

/**
 * Formata a idade de uma mensagem.
 */
function formatarIdadeMensagem(payload: EventoMensagem): string {
  const momento = obterMomentoMensagem(payload);

  if (momento === null) {
    return "desconhecida";
  }

  const idade = Math.max(0, Date.now() - momento);

  const minutos = Math.floor(idade / 60_000);

  const segundos = Math.floor((idade % 60_000) / 1000);

  return `${minutos}min ${segundos}s`;
}

/**
 * Verifica se uma conversa está inativa.
 */
function conversaEstaInativa(conversa: Conversa, agora = Date.now()): boolean {
  /*
   * Encaminhado: ativo até o fim do dia seguinte (não 20 min).
   */
  if (conversa.cliente.status === "HUMANO") {
    return agora >= fimDoDiaLocal(conversa.encaminhadoEm ?? conversa.ultimaMensagemEm, DIAS_ATENDIMENTO_ENCAMINHADO);
  }

  return agora - conversa.ultimaMensagemEm >= INATIVIDADE_MS;
}

/**
 * O atendimento passou para HUMANO (guarda quando, uma vez).
 */
function marcarEncaminhada(conversa: Conversa): void {
  conversa.cliente.status = "HUMANO";

  conversa.encaminhadoEm ??= Date.now();
}

/**
 * Envia uma mensagem ao cliente pela WhatsApp Cloud API (Meta),
 * o ÚNICO canal do MVP. Não há fallback para outro provedor.
 *
 * META_ENVIO_ATIVO decide entre somente log e envio real.
 *
 * aceito = aceito pela Graph API, NÃO é confirmação de
 * entrega. null = não enviado DE PROPÓSITO (modo somente log).
 */
async function enviarAoCliente(
  chatId: string,
  texto: string,
): Promise<ResultadoEnvioMeta | null> {
  if (!ehChatMeta(chatId)) {
    console.error(
      `Envio recusado: ${mascararChatId(chatId)} não é uma conversa da Meta.`,
    );

    return { aceito: false, motivo: "configuracao" };
  }

  if (!metaEnvioAtivo()) {
    console.log(
      `[Meta] resposta não enviada (META_ENVIO_ATIVO=false) | destino: ${descreverDestinoMeta(chatId)} | tamanho: ${texto.length}`,
    );

    return null;
  }

  return enviarTextoMeta(chatId, texto);
}

/**
 * Envio de um aviso do Telegram ao cliente (ex.: vendedor assumiu):
 * mesmas regras de qualquer resposta (META_ENVIO_ATIVO, retry da Meta e
 * alerta geral de falhas). Sem atendimento: nada a desfazer.
 */
async function enviarAvisoAoCliente(chatId: string, texto: string): Promise<ResultadoEnvioCliente> {
  const envio = await enviarAoCliente(chatId, texto);

  if (envio === null) {
    return "somente_log";
  }

  contarResultadoEnvio(envio);

  return envio.aceito ? "enviado" : "falhou";
}

/**
 * Envio de uma mensagem automática do atendimento (fora da resposta da
 * triagem): mesmas regras de envio, com o wamid para o espelho.
 */
async function enviarRespostaAutomatica(
  chatId: string,
  texto: string,
): Promise<{ situacao: "enviado" | "somente_log" | "falhou"; wamid: string | null }> {
  const envio = await enviarAoCliente(chatId, texto);

  if (envio === null) {
    return { situacao: "somente_log", wamid: null };
  }

  contarResultadoEnvio(envio);

  return envio.aceito ? { situacao: "enviado", wamid: envio.wamid } : { situacao: "falhou", wamid: null };
}

/**
 * Conta o resultado de um envio real para o alerta geral
 * (falhas seguidas e "voltou ao normal"). Não espera o Telegram.
 */
function contarResultadoEnvio(envio: ResultadoEnvioMeta): void {
  if (envio.aceito) {
    void registrarEnvioAceito();
  } else {
    void registrarFalhaEnvio(motivoDaFalhaEnvio(envio.motivo));
  }
}

/**
 * Cria um cliente novo a partir do wa_id da Meta.
 */
function criarCliente(senderPhone?: string): Cliente {
  const telefone = normalizarTelefone(senderPhone) || "Não informado";

  return {
    telefone,

    status: "IA",

    resumo: {
      nome: "Não informado",

      telefone,

      produto: "Não informado",

      quantidade: "Não informado",

      observacoes: "Não informado",
    },
  };
}

/**
 * Cria uma nova conversa.
 */
function criarNovaConversa(senderPhone?: string): Conversa {
  const usarClaude =
    (process.env.USAR_IA ?? "").trim().toLowerCase() === "claude";

  const atendimentoId = gerarAtendimentoId();

  const ia: IA = new IAClaude(atendimentoId);

  const agora = Date.now();

  const conversa: Conversa = {
    cliente: criarCliente(senderPhone),

    ia,

    atendimentoId,

    vendedorAssumiu: false,

    ultimaMensagemEm: agora,

    ultimoInstanteEspelho: 0,

    avisoFalhaEnvio: false,

    avisoJaEncaminhado: false,

    encaminhadoEm: null,
  };

  console.log("Nova conversa criada");

  console.log(`Atendimento interno: ${conversa.atendimentoId}`);

  console.log("IA utilizada: Claude");

  return conversa;
}

/**
 * Finaliza uma conversa por inatividade.
 */
function finalizarConversa(chatId: string, conversa: Conversa): void {
  conversas.delete(chatId);

  /*
   * Espelho no banco (não bloqueia; nunca lança).
   */
  void registrarEncerramentoAtendimento(conversa.atendimentoId);

  console.log(
    `Atendimento ${conversa.atendimentoId} encerrado por inatividade.`,
  );
}

/**
 * Obtém a conversa ativa.
 *
 * Se a anterior passou de 20 minutos,
 * ela é encerrada e uma nova é criada.
 */
function obterConversa(chatId: string, senderPhone?: string): Conversa {
  const existente = conversas.get(chatId);

  if (existente) {
    /*
     * Atualiza o telefone caso ele esteja disponível.
     */
    const telefone = normalizarTelefone(senderPhone);

    if (telefone) {
      existente.cliente.telefone = telefone;
      existente.cliente.resumo.telefone = telefone;
    }

    /*
     * Se ainda estiver dentro dos 20 minutos,
     * continuamos no mesmo atendimento.
     */
    if (!conversaEstaInativa(existente)) {
      return existente;
    }

    /*
     * Mais de 20 minutos sem atividade:
     * encerra o atendimento antigo.
     */
    finalizarConversa(chatId, existente);
  }

  /*
   * Não existe atendimento ativo.
   * Portanto criamos um novo.
   */
  const nova = criarNovaConversa(senderPhone);

  conversas.set(chatId, nova);

  return nova;
}

/**
 * Responde a uma mensagem recebida com a loja fechada.
 *
 * Não cria atendimento, não chama a IA e não
 * gera resumo. O aviso vai uma única vez por
 * período fechado para cada chatId.
 */
async function avisarLojaFechada(chatId: string): Promise<void> {
  const periodo = chavePeriodoFechado();

  if (avisosLojaFechada.get(chatId) === periodo) {
    console.log(
      `Loja fechada: aviso já enviado neste período para ${mascararChatId(chatId)}; mensagem sem resposta.`,
    );

    return;
  }

  /*
   * Modo log-only da Meta conta como avisado,
   * igual ao restante do fluxo.
   */
  const modoSomenteLog = !metaEnvioAtivo();

  const envio = await enviarAoCliente(chatId, mensagemLojaFechada());

  const enviado = envio?.aceito === true;

  /*
   * Sem atendimento: a falha só conta para o alerta geral.
   */
  if (envio) {
    contarResultadoEnvio(envio);
  }

  if (enviado || modoSomenteLog) {
    avisosLojaFechada.set(chatId, periodo);

    console.log(`Loja fechada: aviso enviado para ${mascararChatId(chatId)}.`);
  } else {
    console.error(
      `Loja fechada: aviso não entregue para ${mascararChatId(chatId)}; será tentado na próxima mensagem.`,
    );
  }
}

/**
 * Instante da próxima mensagem do espelho: nunca igual nem
 * anterior ao da mensagem anterior da mesma conversa.
 */
function proximoInstanteEspelho(conversa: Conversa): number {
  conversa.ultimoInstanteEspelho = Math.max(
    Date.now(),
    conversa.ultimoInstanteEspelho + 1,
  );

  return conversa.ultimoInstanteEspelho;
}

/**
 * Estado da memória que o espelho grava em atendimentos.
 */
type EstadoEspelhavel = {
  codigo: string;

  status: StatusAtendimento;

  triagem: EstadoTriagem;

  resumo: Pick<Cliente["resumo"], "nome" | "produto" | "quantidade" | "observacoes">;
};

function estadoEspelhavel(conversa: Conversa): EstadoEspelhavel {
  const { nome, produto, quantidade, observacoes } = conversa.cliente.resumo;

  return {
    codigo: conversa.atendimentoId,

    status: conversa.cliente.status,

    triagem: conversa.ia.estadoTriagem(),

    resumo: { nome, produto, quantidade, observacoes },
  };
}

/**
 * Cópia do estado espelhável da conversa ativa de um chat
 * (somente leitura; usada pelos testes para comparar
 * memória × banco).
 */
export function lerEstadoEspelhavel(chatId: string): EstadoEspelhavel | null {
  const conversa = conversas.get(chatId);

  return conversa ? estadoEspelhavel(conversa) : null;
}

/**
 * Espelha no banco o estado FINAL da memória depois de uma
 * mensagem processada. Falha de banco só gera log.
 */
async function espelharMensagem(
  chatId: string,
  conversa: Conversa,
  entrada: MensagemEspelho | null,
  saida: MensagemEspelho | null,
): Promise<void> {
  const estado = estadoEspelhavel(conversa);

  await registrarMensagemProcessada({
    codigo: estado.codigo,
    chatId,
    telefone: conversa.cliente.telefone,
    atividadeEm: conversa.ultimaMensagemEm,
    encerrado: conversa.vendedorAssumiu,
    status: estado.status,
    triagem: estado.triagem,
    resumo: estado.resumo,
    entrada,
    saida,
  });
}

/**
 * Processa mensagem recebida do cliente.
 */
async function processarMensagemRecebida(payload: EventoMensagem): Promise<void> {
  const data = payload.data;

  if (!data) {
    return;
  }

  const chatId = typeof data.chatId === "string" ? data.chatId : "";

  const midia = data.midia ?? null;

  /*
   * Mídia (B7) entra no histórico como texto do cliente:
   * "[enviou imagem com a legenda]: ..." ou "[enviou áudio]".
   */
  const texto = midia ? textoDaMidia(midia) : typeof data.body === "string" ? data.body.trim() : "";

  if (!chatId || !texto) {
    void marcarEventosProcessados("META", [chaveEventoExterno(payload)]);

    return;
  }

  /*
   * Só texto e as mídias tratadas.
   */
  if (!midia && typeof data.type === "string" && data.type !== "text") {
    void marcarEventosProcessados("META", [chaveEventoExterno(payload)]);

    return;
  }

  /*
   * Atividade pelo relógio LOCAL, no momento em que a mensagem chegou
   * (antes da fila): o timestamp da Meta pode vir atrasado ou com o
   * relógio do aparelho, e a inatividade contaria de antes da chegada.
   */
  const recebidaEm = Date.now();

  /*
   * Agrupamento: mensagens seguidas do mesmo cliente viram UM turno
   * (síncrono até aqui: a ordem do lote da Meta é preservada).
   */
  receberNoLote(chatId, { payload, texto, midia, senderPhone: data.senderPhone, recebidaEm });
}

/*
 * Agrupamento de mensagens seguidas (o cliente costuma mandar 2-3 de uma
 * vez). A mensagem espera JANELA_AGRUPAMENTO_MS depois da última do lote,
 * no máximo MAXIMO_AGRUPAMENTO_MS desde a primeira; então o lote vai para
 * a fila da conversa como um turno só (textos em ordem, separados por
 * quebra de linha; cada mídia é um turno próprio, na mesma ordem).
 *
 * AGRUPAMENTO_JANELA_MS / AGRUPAMENTO_MAXIMO_MS só para testes (não
 * definir em produção); 0 = sem agrupamento (cada mensagem é um turno).
 */
const JANELA_AGRUPAMENTO_MS = 4_000;

const MAXIMO_AGRUPAMENTO_MS = 12_000;

/*
 * Mensagens novas chegaram durante a chamada da IA: a resposta é
 * descartada (o próximo lote responde com todo o contexto), no máximo
 * esse número de vezes seguidas por conversa.
 */
const MAX_DESCARTES_SEGUIDOS = 2;

function agrupamento(): { janela: number; maximo: number } {
  const ler = (nome: string, padrao: number) => {
    const valor = Number(process.env[nome] ?? padrao);

    return Number.isFinite(valor) && valor >= 0 ? valor : padrao;
  };

  return { janela: ler("AGRUPAMENTO_JANELA_MS", JANELA_AGRUPAMENTO_MS), maximo: ler("AGRUPAMENTO_MAXIMO_MS", MAXIMO_AGRUPAMENTO_MS) };
}

type ItemLote = {
  payload: EventoMensagem;
  texto: string;
  midia: MidiaRecebida | null;
  senderPhone: string | undefined;
  recebidaEm: number;
};

type Turno = {
  chatId: string;
  texto: string;
  midia: MidiaRecebida | null;
  senderPhone: string | undefined;
  recebidaEm: number;
  chaveExterna: string;
};

const lotesPendentes = new Map<string, { itens: ItemLote[]; primeiraEm: number; timer: ReturnType<typeof setTimeout> | null }>();

/*
 * Tarefas na fila de cada conversa (a que roda conta): mais de 1 =
 * já há mensagem nova esperando.
 */
const tarefasNaFila = new Map<string, number>();

const descartesSeguidos = new Map<string, number>();

function receberNoLote(chatId: string, item: ItemLote): void {
  const { janela, maximo } = agrupamento();

  if (janela <= 0) {
    enfileirarLote(chatId, [item]);

    return;
  }

  const agora = Date.now();

  let lote = lotesPendentes.get(chatId);

  if (!lote) {
    lote = { itens: [], primeiraEm: agora, timer: null };

    lotesPendentes.set(chatId, lote);
  }

  lote.itens.push(item);

  if (lote.timer) {
    clearTimeout(lote.timer);
  }

  const espera = Math.max(0, Math.min(janela, lote.primeiraEm + maximo - agora));

  lote.timer = setTimeout(() => fecharLote(chatId), espera);
}

function fecharLote(chatId: string): void {
  const lote = lotesPendentes.get(chatId);

  if (!lote) {
    return;
  }

  if (lote.timer) {
    clearTimeout(lote.timer);
  }

  lotesPendentes.delete(chatId);

  enfileirarLote(chatId, lote.itens);
}

/**
 * Fecha todos os lotes na hora (desligamento ordenado).
 */
function fecharTodosOsLotes(): void {
  for (const chatId of [...lotesPendentes.keys()]) {
    fecharLote(chatId);
  }
}

/*
 * Textos seguidos viram um turno só; cada mídia é um turno.
 */
function segmentarLote(chatId: string, itens: ItemLote[]): Turno[] {
  const turnos: Turno[] = [];

  for (const item of itens) {
    const ultimo = turnos.at(-1);

    if (!item.midia && ultimo && !ultimo.midia) {
      ultimo.texto = `${ultimo.texto}\n${item.texto}`;

      ultimo.recebidaEm = item.recebidaEm;

      ultimo.chaveExterna = chaveEventoExterno(item.payload);

      ultimo.senderPhone = item.senderPhone ?? ultimo.senderPhone;

      continue;
    }

    turnos.push({
      chatId,
      texto: item.texto,
      midia: item.midia,
      senderPhone: item.senderPhone,
      recebidaEm: item.recebidaEm,
      chaveExterna: chaveEventoExterno(item.payload),
    });
  }

  return turnos;
}

function enfileirarLote(chatId: string, itens: ItemLote[]): void {
  tarefasNaFila.set(chatId, (tarefasNaFila.get(chatId) ?? 0) + 1);

  adicionarNaFila(chatId, async () => {
    try {
      if (itens.length > 1) {
        console.log(`Lote de ${itens.length} mensagens de ${mascararChatId(chatId)} processado como um turno.`);
      }

      for (const turno of segmentarLote(chatId, itens)) {
        await atenderTurno(turno);
      }
    } finally {
      const restantes = (tarefasNaFila.get(chatId) ?? 1) - 1;

      if (restantes > 0) {
        tarefasNaFila.set(chatId, restantes);
      } else {
        tarefasNaFila.delete(chatId);
      }

      await marcarEventosProcessados("META", itens.map((item) => chaveEventoExterno(item.payload)));
    }
  });
}

/*
 * Chegou mensagem nova do cliente durante a chamada da IA? Então a
 * resposta (de triagem) é descartada: o próximo lote responde com todo
 * o contexto. Limite de descartes seguidos para nunca deixar o cliente
 * sem resposta. Só com o agrupamento ligado.
 */
function deveDescartarResposta(chatId: string): boolean {
  if (agrupamento().janela <= 0) {
    return false;
  }

  const novas = lotesPendentes.has(chatId) || (tarefasNaFila.get(chatId) ?? 0) > 1;

  const feitos = descartesSeguidos.get(chatId) ?? 0;

  if (!novas || feitos >= MAX_DESCARTES_SEGUIDOS) {
    descartesSeguidos.delete(chatId);

    return false;
  }

  descartesSeguidos.set(chatId, feitos + 1);

  return true;
}

/**
 * Recuperação: mensagens que esperavam o lote (ou a fila) quando o
 * processo caiu voltam para o lote, em ordem. Exportada para os testes.
 */
export async function reprocessarMensagensPendentes(): Promise<number> {
  const phoneNumberId = (process.env.META_PHONE_NUMBER_ID ?? "").trim();

  if (!/^\d+$/.test(phoneNumberId)) {
    return 0;
  }

  const pendentes = await lerEventosPendentes("META", `meta:${phoneNumberId}:`);

  if (!pendentes || pendentes.length === 0) {
    return 0;
  }

  for (const evento of pendentes) {
    void processarEvento(evento as EventoMensagem).catch((erro: unknown) => {
      console.error("Erro ao reprocessar mensagem pendente:", descreverErro(erro));
    });
  }

  console.log(`[Recuperação] ${pendentes.length} mensagem(ns) pendente(s) devolvida(s) ao processamento.`);

  return pendentes.length;
}

/**
 * Um turno do cliente (um lote de textos ou uma mídia).
 */
async function atenderTurno(turno: Turno): Promise<void> {
  const { chatId, texto, midia, recebidaEm } = turno;

  const data = { senderPhone: turno.senderPhone };

  /*
   * Horário de funcionamento.
   *
   * Fora do horário, só um atendimento que
   * já estava ativo continua. Mensagem sem
   * atendimento ativo recebe o aviso de loja
   * fechada e não inicia triagem.
   */
  const ativa = conversas.get(chatId);

  const temAtendimentoAtivo = !!ativa && !conversaEstaInativa(ativa);

  if (!temAtendimentoAtivo && !lojaAberta()) {
    await avisarLojaFechada(chatId);

    return;
  }

  const conversa = obterConversa(chatId, data.senderPhone);

  /*
   * Usa o momento em que a mensagem chegou,
   * não o momento em que a IA terminou.
   */
  conversa.ultimaMensagemEm = recebidaEm;

  /*
   * Espelho no banco: cria (1ª mensagem) ou atualiza a
   * última atividade do atendimento com o MESMO codigo.
   * Dentro da tarefa da fila (ordem preservada), antes da IA
   * (nenhuma conexão fica presa esperando Claude/Meta/Telegram).
   * Falha de banco só gera log; o atendimento segue em memória.
   */
  await registrarAtividadeAtendimento({
    codigo: conversa.atendimentoId,
    chatId,
    telefone: conversa.cliente.telefone,
    atividadeEm: conversa.ultimaMensagemEm,
    encerrado: conversa.vendedorAssumiu,
  });

  /*
   * Mensagem do cliente para o espelho (ENTRADA). Gravada junto
   * com o estado final, depois do processamento.
   */
  const chaveExterna = turno.chaveExterna;

  const entrada: MensagemEspelho = {
    wamid: idRegistravel(chaveExterna) ? chaveExterna : null,
    texto,
    em: proximoInstanteEspelho(conversa),
  };

  /*
   * Espelho (Passo 5b): QUALQUER saída daqui em diante (return,
   * erro inesperado ou fim normal) grava a ENTRADA com o estado
   * da memória naquele momento, já depois de um eventual desfazer.
   */
  let saida: MensagemEspelho | null = null;

  /*
   * A resposta não chegou ao cliente: o grupo recebe o resumo
   * com o aviso (decidido dentro do try, publicado depois).
   */
  let avisarFalhaNoGrupo = false;

  let resultado: ResultadoIA;

  try {
    /*
     * Sem texto e sem telefone completo (LGPD).
     */
    console.log(
      [
        "Mensagem recebida (Meta)",
        `atendimento: ${conversa.atendimentoId}`,
        `chatId: ${mascararChatId(chatId)}`,
        // Mídia: só o tipo e se tinha legenda (nunca id, url ou a legenda).
        midia ? `mídia: ${midia.tipo} | legenda: ${midia.legenda ? "sim" : "não"}` : `tamanho: ${texto.length}`,
        `senderPhone: ${data.senderPhone ? mascararTelefone(normalizarTelefone(data.senderPhone)) : "Não informado"}`,
      ].join(" | "),
    );

    /*
     * Se vendedor já assumiu,
     * a IA permanece desligada.
     */
    if (conversa.cliente.status === "HUMANO") {
      /*
       * Sem conteúdo ("ok", "tá bom", 👍) ou mídia sem legenda: nada ao
       * cliente nem ao vendedor (fica só no espelho). Mídia com legenda:
       * vale a legenda, como texto.
       */
      const conteudo = conteudoDepoisDoEncaminhamento(texto, midia);

      if (conteudo === null) {
        console.log(`Atendimento ${conversa.atendimentoId}: mensagem sem conteúdo depois do encaminhamento; nada respondido nem repassado.`);

        return;
      }

      /*
       * Encaminhado e ninguém assumiu ainda: o cliente fica sabendo,
       * uma vez por atendimento. Assumido: nada (o vendedor fala).
       */
      if (!conversa.vendedorAssumiu && !conversa.avisoJaEncaminhado) {
        conversa.avisoJaEncaminhado = true;

        const texto = lojaAberta() ? MENSAGEM_JA_ENCAMINHADO : MENSAGEM_JA_ENCAMINHADO_FECHADA;

        const envio = await enviarRespostaAutomatica(chatId, texto);

        if (envio.situacao !== "falhou") {
          saida = { wamid: envio.wamid, texto, em: proximoInstanteEspelho(conversa) };
        }

        console.log(
          `Atendimento ${conversa.atendimentoId}: mensagem depois do encaminhamento; cliente avisado de que já foi passado ao vendedor (${envio.situacao}).`,
        );
      } else {
        console.log(
          `IA desativada para ${mascararChatId(chatId)}: atendimento humano.`,
        );
      }

      /*
       * Sem triagem nova nem resumo novo: a mensagem vai ao vendedor que
       * assumiu (privado) ou, sem ninguém, ao grupo (resposta ao resumo).
       */
      if (telegramConfigurado()) {
        const destino = await repassarMensagemAoVendedor(
          conversa.atendimentoId,
          chatId,
          conversa.cliente.resumo,
          conteudo,
        );

        console.log(`Atendimento ${conversa.atendimentoId}: mensagem do cliente repassada (${destino}).`);
      }

      return;
    }

    try {
      resultado = midia
        ? await conversa.ia.responderMidia(midia, conversa.cliente, recebidaEm)
        : await conversa.ia.responder(texto, conversa.cliente);
    } catch (erro: unknown) {
      console.error(
        `Falha na IA (${conversa.atendimentoId}): ${descreverErro(erro)}`,
      );

      const observacoes = conversa.cliente.resumo.observacoes;

      const nota = "Falha técnica na triagem automática.";

      resultado = {
        resposta:
          "Tive uma instabilidade aqui. Vou encaminhar seu atendimento para um vendedor da loja, que dará continuidade.",

        status: "HUMANO",

        resumo: {
          ...conversa.cliente.resumo,

          telefone: conversa.cliente.telefone,

          observacoes: conversa.ia.anexarLegendas(
            observacoes === "Não informado" ? nota : `${observacoes} | ${nota}`,
          ),
        },
      };
    }

    /*
     * IMPORTANTE:
     *
     * Um vendedor pode ter assumido pelo Telegram
     * enquanto a Claude estava processando.
     *
     * Nesse caso, HUMANO tem prioridade.
     */
    if (conversa.vendedorAssumiu) {
      marcarEncaminhada(conversa);

      console.log(
        `Atendimento ${conversa.atendimentoId} foi assumido pelo vendedor durante o processamento da IA.`,
      );

      /*
       * Atualizamos apenas o resumo.
       *
       * Não enviamos a resposta automática
       * da Claude.
       */
      conversa.cliente.resumo = resultado.resumo;

      return;
    }

    /*
     * Resultado normal da IA.
     */
    conversa.cliente.status = resultado.status;

    if (resultado.status === "HUMANO") {
      marcarEncaminhada(conversa);
    }

    conversa.cliente.resumo = resultado.resumo;

    /*
     * Mídia do mesmo envio da que já recebeu o aviso: nada a
     * enviar (a ENTRADA vai para o espelho no finally).
     */
    if (resultado.resposta === "") {
      return;
    }

    /*
     * Mensagens novas do cliente chegaram durante a chamada da IA: esta
     * resposta já não serve (o contexto mudou). Desfeita, não é enviada;
     * o próximo lote responde. O que a IA entendeu desta mensagem fica.
     */
    if (resultado.status === "IA" && deveDescartarResposta(chatId)) {
      conversa.ia.desfazerRespostaNaoEntregue();

      console.log(`Atendimento ${conversa.atendimentoId}: resposta descartada (mensagens novas do cliente); o próximo lote responde.`);

      return;
    }

    /*
     * Triagem iniciada antes do fechamento e
     * concluída depois: o cliente fica sabendo
     * que o vendedor só retorna na reabertura.
     */
    if (resultado.status === "HUMANO" && !lojaAberta()) {
      resultado.resposta = `${resultado.resposta}\n\n${AVISO_ENCAMINHAMENTO_FORA_DO_HORARIO}`;
    }

    console.log(`Status: ${resultado.status}`);

    console.log(
      `Resumo (${conversa.atendimentoId}) campos preenchidos: ${camposPreenchidos(conversa.cliente.resumo)}`,
    );

    /*
     * Modo log-only da Meta (META_ENVIO_ATIVO=false):
     * a resposta NÃO é enviada de propósito.
     *
     * Isso não é falha de envio, então o estado
     * da triagem NÃO é desfeito e ela avança normalmente.
     *
     * A flag é lida uma única vez aqui para decidir.
     */
    const modoSomenteLog = !metaEnvioAtivo();

    let clienteAvisado = false;

    let wamidResposta: string | null = null;

    if (modoSomenteLog) {
      console.log(
        `[Meta] resposta não enviada (META_ENVIO_ATIVO=false) | destino: ${descreverDestinoMeta(chatId)} | tamanho: ${resultado.resposta.length}`,
      );
    } else {
      /*
       * Envia a resposta ao cliente (tentativa real).
       */
      const envio = await enviarAoCliente(chatId, resultado.resposta);

      if (envio) {
        contarResultadoEnvio(envio);

        if (envio.aceito) {
          wamidResposta = envio.wamid;

          clienteAvisado = true;
        }
      }
    }

    if (clienteAvisado) {
      /*
       * A resposta automática também
       * representa atividade.
       */
      conversa.ultimaMensagemEm = Date.now();
    } else if (!modoSomenteLog) {
      console.error(
        `Cliente ${mascararChatId(chatId)} não recebeu a resposta.`,
      );

      /*
       * Houve tentativa REAL de envio e ela falhou:
       * a pergunta não pode ficar registrada como feita.
       *
       * Só durante a triagem (IA). Em HUMANO nada é
       * desfeito: a triagem não reabre e o resumo
       * segue o fluxo normal, uma única vez.
       */
      if (resultado.status === "IA") {
        conversa.ia.desfazerRespostaNaoEntregue();

        console.log(
          `Atendimento ${conversa.atendimentoId}: resposta não entregue desfeita.`,
        );
      }

      /*
       * A IA para de responder este cliente (HUMANO) e o grupo
       * recebe o resumo com o aviso, para um vendedor assumir e
       * falar com ele pelo WhatsApp. Um aviso por atendimento.
       */
      marcarEncaminhada(conversa);

      /*
       * Legendas de mídia do atendimento para o vendedor ver.
       */
      conversa.cliente.resumo.observacoes = conversa.ia.anexarLegendas(conversa.cliente.resumo.observacoes);

      if (!conversa.avisoFalhaEnvio) {
        conversa.avisoFalhaEnvio = true;

        avisarFalhaNoGrupo = true;
      }
    }

    /*
     * A SAIDA só entra se a Meta aceitou ou em modo
     * somente log (mesma regra da memória).
     */
    if (clienteAvisado || modoSomenteLog) {
      saida = {
        wamid: wamidResposta,
        texto: resultado.resposta,
        em: proximoInstanteEspelho(conversa),
      };
    }
  } finally {
    await espelharMensagem(chatId, conversa, entrada, saida);
  }

  /*
   * Quando a IA conclui o atendimento, o resumo vai
   * SOMENTE para o grupo de vendedores no Telegram
   * (idempotente por atendimento).
   */
  if (resultado.status === "HUMANO" || avisarFalhaNoGrupo) {
    if (!telegramConfigurado()) {
      if (avisarFalhaNoGrupo) {
        console.error(
          `Atendimento ${conversa.atendimentoId}: resposta não entregue e Telegram não configurado; grupo não avisado.`,
        );
      }
    } else if (avisarFalhaNoGrupo && situacaoResumoTelegram(conversa.atendimentoId) === "enviado") {
      /*
       * Hoje não acontece: depois do resumo a IA não envia mais
       * nada ao cliente. (O aviso por reply ao resumo não foi
       * implementado.)
       */
      console.error(
        `Atendimento ${conversa.atendimentoId}: resposta não entregue depois do resumo publicado; grupo não avisado.`,
      );
    } else {
      await enviarResumoTelegram(
        conversa.atendimentoId,
        chatId,
        conversa.cliente.resumo,
        { avisoFalhaEnvio: avisarFalhaNoGrupo },
      );
    }

    console.log(
      `Atendimento transferido para humano: ${mascararChatId(chatId)}`,
    );
  }
}

/**
 * Mantém mensagens de um mesmo cliente
 * em ordem.
 */
function adicionarNaFila(chatId: string, tarefa: () => Promise<void>): void {
  const anterior = conversationQueues.get(chatId) ?? Promise.resolve();

  const atual = anterior
    .catch(() => undefined)
    .then(tarefa)
    .catch((erro: unknown) => {
      console.error(
        "Erro ao processar mensagem:",
        descreverErro(erro),
      );
    });

  conversationQueues.set(chatId, atual);

  void atual.finally(() => {
    if (conversationQueues.get(chatId) === atual) {
      conversationQueues.delete(chatId);
    }
  });
}

/**
 * Finaliza automaticamente atendimentos
 * que ficaram 20 minutos sem atividade.
 */
export function verificarInatividade(): void {
  const agora = Date.now();

  for (const [chatId, conversa] of conversas) {
    /*
     * Tarefa da conversa na fila (mensagem esperando ou IA
     * respondendo) ou lote aberto: não mexe no meio; a tarefa
     * atualiza a atividade e o próximo ciclo decide.
     */
    if (conversationQueues.has(chatId) || lotesPendentes.has(chatId)) {
      continue;
    }

    /*
     * Cliente parou de responder na triagem: o atendimento vai ao
     * vendedor com o que já tem (antes de qualquer encerramento).
     */
    if (paradaParaEncaminhar(conversa, agora)) {
      adicionarNaFila(chatId, () => encaminharConversaParada(chatId, conversa));

      continue;
    }

    if (!conversaEstaInativa(conversa, agora)) {
      continue;
    }

    finalizarConversa(chatId, conversa);
  }

  /*
   * Com a loja aberta, nenhum aviso de
   * período fechado anterior vale mais.
   */
  if (avisosLojaFechada.size > 0 && lojaAberta(agora)) {
    avisosLojaFechada.clear();
  }
}

function campoInformado(valor: string): boolean {
  const limpo = valor.trim();

  return limpo !== "" && limpo !== "Não informado";
}

/**
 * Triagem parada que deve ir ao vendedor: na etapa das observações há
 * ENCAMINHAR_SEM_OBSERVACOES_MS (sem aviso); em outra etapa, com nome
 * ou produto, há ENCAMINHAR_CLIENTE_PAROU_MS (com o aviso da etapa).
 * Sem nome nem produto ("oi"): null (encerra como antes, sem resumo).
 */
function paradaParaEncaminhar(conversa: Conversa, agora: number): { motivo: MotivoEncaminhamentoAutomatico; etapa: string | null } | null {
  if (conversa.vendedorAssumiu || conversa.cliente.status !== "IA") {
    return null;
  }

  const parado = agora - conversa.ultimaMensagemEm;

  /*
   * Mídia (com ou sem legenda) e nada escrito depois do aviso que pede o
   * texto.
   */
  if (conversa.ia.midiaSemContinuacao() !== null && parado >= ENCAMINHAR_MIDIA_SEM_TEXTO_MS) {
    return { motivo: "midia", etapa: null };
  }

  const etapa = conversa.ia.etapaAguardandoResposta();

  if (etapa === "observacoes" && parado >= ENCAMINHAR_SEM_OBSERVACOES_MS) {
    return { motivo: "observacoes", etapa: null };
  }

  const { nome, produto } = conversa.cliente.resumo;

  if ((campoInformado(nome) || campoInformado(produto)) && parado >= ENCAMINHAR_CLIENTE_PAROU_MS) {
    return { motivo: "parou", etapa: etapa ? NOME_DA_ETAPA[etapa] : "início" };
  }

  return null;
}

/**
 * Encaminha ao vendedor a triagem em que o cliente parou de responder
 * (dentro da fila da conversa): resumo no grupo e a mensagem normal de
 * encaminhamento ao cliente. Confere de novo: o cliente pode ter
 * respondido nesse meio-tempo.
 */
async function encaminharConversaParada(chatId: string, conversa: Conversa): Promise<void> {
  const agora = Date.now();

  const parada = conversas.get(chatId) === conversa ? paradaParaEncaminhar(conversa, agora) : null;

  if (!parada) {
    return;
  }

  const minutos = Math.floor((agora - conversa.ultimaMensagemEm) / 60_000);

  const resultado = conversa.ia.encaminharPorInatividade(parada.motivo, lojaAberta());

  marcarEncaminhada(conversa);

  conversa.cliente.resumo = resultado.resumo;

  const resposta = resultado.resposta;

  console.log(
    `Atendimento ${conversa.atendimentoId}: cliente parou de responder (${minutos} min, ${parada.motivo === "midia" ? "só mídia, sem texto" : `etapa ${parada.etapa ?? "observações"}`}); encaminhado ao vendedor automaticamente.`,
  );

  const envio = await enviarRespostaAutomatica(chatId, resposta);

  let saida: MensagemEspelho | null = null;

  if (envio.situacao === "falhou") {
    console.error(`Cliente ${mascararChatId(chatId)} não recebeu a mensagem de encaminhamento.`);
  } else {
    conversa.ultimaMensagemEm = Date.now();

    saida = { wamid: envio.wamid, texto: resposta, em: proximoInstanteEspelho(conversa) };
  }

  const avisoFalhaEnvio = envio.situacao === "falhou" && !conversa.avisoFalhaEnvio;

  if (avisoFalhaEnvio) {
    conversa.avisoFalhaEnvio = true;
  }

  await espelharMensagem(chatId, conversa, null, saida);

  if (!telegramConfigurado()) {
    console.error(`Atendimento ${conversa.atendimentoId}: encaminhado por inatividade e Telegram não configurado; resumo não publicado.`);

    return;
  }

  await enviarResumoTelegram(conversa.atendimentoId, chatId, conversa.cliente.resumo, {
    avisoFalhaEnvio,
    ...(parada.etapa ? { etapaParada: parada.etapa } : {}),
  });
}

/**
 * Associa um status da Meta ao atendimento
 * que originou a mensagem.
 *
 * Apenas registra: não reenvia, não muda
 * o estado da IA, não cria atendimento e
 * não passa para HUMANO.
 */
function tratarStatusMeta(status: MetaStatus): void {
  const wamid = status.id ?? "";

  const situacao = valorSeguro(status.status);

  const chatId = wamid ? obterChatIdPorWamid(wamid) : null;

  if (!chatId) {
    console.log(
      `[Meta] status ${situacao} para wamid sem correspondência (envio anterior, expirado ou de outra origem): ${wamid ? wamidSeguro(wamid) : "não informado"}`,
    );

    return;
  }

  const conversa = conversas.get(chatId);

  const partes = [
    `[Meta] status ${situacao} associado`,
    `atendimento: ${conversa ? conversa.atendimentoId : "já encerrado"}`,
    `destino: ${descreverDestinoMeta(chatId)}`,
    `wamid: ${wamidSeguro(wamid)}`,
  ];

  if (situacao !== "failed") {
    console.log(partes.join(" | "));

    return;
  }

  for (const erro of status.errors ?? []) {
    partes.push(`erro code: ${erro.code ?? "não informado"}`);

  }

  partes.push("sem reenvio automático");

  console.error(partes.join(" | "));
}

/**
 * ID externo do evento: idempotencyKey (wamid da Meta) e,
 * na falta dele, data.id.
 */
function chaveEventoExterno(payload: EventoMensagem): string {
  return payload.idempotencyKey ?? payload.data?.id ?? "";
}

/**
 * Registra uma MENSAGEM RECEBIDA em eventos_processados.
 *
 * - "processar": evento novo, ou sem ID externo utilizável
 *   (não registrável: segue o fluxo normal, como antes);
 * - "duplicado": já registrado; não processar;
 * - "falha": erro de banco; não processar e NÃO é duplicata.
 */
async function registrarMensagemRecebida(
  canal: CanalEvento,
  chave: string,
  evento?: EventoMensagem,
): Promise<"processar" | "duplicado" | "falha"> {
  if (!idRegistravel(chave)) {
    if (chave !== "") {
      console.warn(
        `[Dedup] ${canal}: ID externo com ${chave.length} caracteres não cabe em eventos_processados; processado sem deduplicação.`,
      );
    }

    return "processar";
  }

  try {
    const resultado = await registrarEventoRecebido(canal, chave, evento);

    if (resultado === "duplicado") {
      console.log(`[Dedup] ${canal}: mensagem duplicada ignorada: ${wamidSeguro(chave)}`);

      return "duplicado";
    }

    return "processar";
  } catch (erro: unknown) {
    const codigo = (erro as { code?: unknown })?.code;

    console.error(
      `[Dedup] ${canal}: falha ao registrar em eventos_processados (${typeof codigo === "string" ? codigo : erro instanceof Error ? erro.name : "erro"}); mensagem NÃO processada.`,
    );

    return "falha";
  }
}

/**
 * Processa uma mensagem recebida da Meta.
 *
 * A deduplicação já aconteceu na rota (eventos_processados).
 *
 * Não há await antes de processarMensagemRecebida chegar em
 * adicionarNaFila: isso mantém a ordem de um lote messages[].
 */
async function processarEvento(payload: EventoMensagem): Promise<void> {
  if (payload.event !== "message.received" || !payload.data) {
    void marcarEventosProcessados("META", [chaveEventoExterno(payload)]);

    return;
  }

  /*
   * Mensagem com mais de 20 minutos não pode
   * iniciar um novo atendimento.
   */
  if (mensagemComMaisDe20Minutos(payload)) {
    void marcarEventosProcessados("META", [chaveEventoExterno(payload)]);

    /*
     * O cliente fica sem resposta: log em destaque e aviso aos
     * administradores (no máximo 1 a cada 30 min). Sem await aqui
     * (ordem do lote).
     */
    console.error(
      [
        "ATENÇÃO: Evento antigo ignorado; o cliente ficou sem resposta.",
        `Evento: ${payload.event}`,
        `Chat: ${mascararChatId(typeof payload.data.chatId === "string" ? payload.data.chatId : "")}`,
        `Idade: ${formatarIdadeMensagem(payload)}`,
      ].join(" | "),
    );

    void registrarMensagemDescartada();

    return;
  }

  await processarMensagemRecebida(payload);
}

/*
 * Tempo máximo da recuperação na partida. Estourou: sobe com a
 * memória vazia (nunca deixa de subir por causa do banco).
 */
const LIMITE_RECUPERACAO_MS = 30_000;

/**
 * Monta a conversa em memória a partir do banco.
 *
 * Assumida (vendedor já registrado): a IA continua calada, como
 * a memória faria até a inatividade. Nunca reabre para a IA.
 */
function montarConversaRecuperada(c: ConversaRecuperada): Conversa {
  const resumo: Cliente["resumo"] = {
    nome: c.nome ?? "Não informado",
    telefone: c.telefone,
    produto: c.produto ?? "Não informado",
    quantidade: c.quantidade ?? "Não informado",
    observacoes: c.observacoes ?? "Não informado",
  };

  const ia = new IAClaude(c.codigo);

  ia.restaurar({
    triagem: {
      etapaAtual: c.etapaAtual,
      perguntasEtapa: c.perguntasEtapa,
      etapasPuladas: c.etapasPuladas,
      apresentacaoPendente: c.apresentacaoPendente,
      quantidadeNaoAplicavel: c.quantidadeNaoAplicavel,
    },
    resumo,
    historico: c.historico.map((m) => ({
      papel: m.direcao === "ENTRADA" ? "user" : "assistant",
      texto: m.texto,
    })),
    ultimaMensagemEm: c.ultimaAtividadeEm,
  });

  return {
    cliente: {
      telefone: c.telefone,
      status: c.assumida ? "HUMANO" : c.status,
      resumo: { ...resumo },
    },
    ia,
    atendimentoId: c.codigo,
    vendedorAssumiu: c.assumida,
    ultimaMensagemEm: c.ultimaAtividadeEm,
    ultimoInstanteEspelho: c.ultimaMensagemEm,
    avisoFalhaEnvio: false,
    avisoJaEncaminhado: false,
    encaminhadoEm: c.encaminhadoEm,
  };
}

export type ResultadoRecuperacao =
  | { ok: true; conversas: number; resumosNaoPublicados: ResumoRecuperado[] }
  | { ok: false };

/*
 * A carga dos fechamentos na partida falhou: tentarCarregarFechamentos
 * repete a cada minuto até conseguir.
 */
let fechamentosPendentes = false;

let carregandoFechamentos = false;

/**
 * Nova tentativa de carregar os fechamentos que falharam na partida.
 * Junta com a memória (/fechar e /abrir feitos nesse meio-tempo
 * continuam valendo). Exportada para os testes.
 */
export async function tentarCarregarFechamentos(): Promise<void> {
  if (!fechamentosPendentes || carregandoFechamentos) {
    return;
  }

  carregandoFechamentos = true;

  try {
    const fechamentos = await lerFechamentos(dataLocal());

    if (fechamentos === null || !fechamentosPendentes) {
      return;
    }

    fechamentosPendentes = false;

    const novos = mesclarDiasFechados(fechamentos);

    console.log(`[Loja] fechamentos manuais carregados na nova tentativa: ${fechamentos.length} (${novos} novo(s) na memória)`);
  } finally {
    carregandoFechamentos = false;
  }
}

/*
 * A abertura manual não carregou na partida (banco fora): de novo a
 * cada minuto, sem passar por cima de uma aberta nesse meio-tempo.
 */
let aberturaPendente = false;

async function carregarAberturaManual(): Promise<boolean> {
  const lida = await lerAberturaManualAtiva();

  if (!lida.ok) {
    return false;
  }

  if (lida.abertura && !aberturaManualRegistrada()) {
    restaurarAberturaManual(lida.abertura);

    console.log(`[Loja] abertura manual ativa recuperada até ${horarioDaLoja(lida.abertura.fim)}.`);
  }

  return true;
}

/**
 * Nova tentativa de carregar a abertura manual que falhou na partida.
 * Exportada para os testes.
 */
export async function tentarCarregarAberturaManual(): Promise<void> {
  if (aberturaPendente && (await carregarAberturaManual())) {
    aberturaPendente = false;
  }
}

/**
 * Recuperação na partida (Passo 5d): lê o banco UMA vez e monta a
 * memória (conversas, lock e resumos do Telegram). Nunca lança.
 *
 * Exportada também para os testes simularem um reinício.
 */
export async function recuperarNaPartida(): Promise<ResultadoRecuperacao> {
  /*
   * Fechamentos manuais da loja (/fechar) de hoje em diante. Banco
   * fora: sobe sem fechamentos (aviso em destaque em lerFechamentos).
   */
  const fechamentos = await lerFechamentos(dataLocal());

  definirDiasFechados(fechamentos ?? []);

  fechamentosPendentes = fechamentos === null;

  if (fechamentos !== null) {
    console.log(`[Loja] fechamentos manuais carregados: ${fechamentos.length}`);
  }

  /*
   * Abertura manual (/abrir_agora) ainda válida volta a valer.
   */
  aberturaPendente = !(await carregarAberturaManual());

  const phoneNumberId = (process.env.META_PHONE_NUMBER_ID ?? "").trim();

  if (!/^\d+$/.test(phoneNumberId)) {
    console.error("[Recuperação] ATENÇÃO: META_PHONE_NUMBER_ID ausente ou inválido; subindo com a memória vazia.");

    return { ok: false };
  }

  let ttlResumoMs: number | null = null;

  if (telegramConfigurado()) {
    try {
      ttlResumoMs = lerTelegramResumoTtlHoras() * 60 * 60 * 1000;
    } catch {
      console.error("[Recuperação] TELEGRAM_RESUMO_TTL_HORAS inválido: resumos do Telegram não recuperados.");
    }
  }

  const inicio = Date.now();

  let timer: ReturnType<typeof setTimeout> | undefined;

  const leitura = lerDadosRecuperacao({
    phoneNumberId,
    agora: Date.now(),
    inatividadeMs: INATIVIDADE_MS,
    diasEncaminhado: DIAS_ATENDIMENTO_ENCAMINHADO,
    ttlResumoMs,
  });

  let dados: DadosRecuperacao;

  try {
    const resultado = await Promise.race([
      leitura,
      new Promise<"limite">((resolve) => {
        timer = setTimeout(() => resolve("limite"), LIMITE_RECUPERACAO_MS);
      }),
    ]);

    if (resultado === "limite") {
      leitura.catch(() => undefined);

      console.error(
        `[Recuperação] ATENÇÃO: recuperação passou de ${LIMITE_RECUPERACAO_MS / 1000} s; subindo com a memória vazia.`,
      );

      return { ok: false };
    }

    dados = resultado;
  } catch (erro: unknown) {
    console.error(
      `[Recuperação] ATENÇÃO: banco indisponível na partida (${descreverErro(erro)}); subindo com a memória vazia.`,
    );

    return { ok: false };
  } finally {
    clearTimeout(timer);
  }

  for (const c of dados.conversas) {
    conversas.set(c.chatId, montarConversaRecuperada(c));
  }

  const telegram = restaurarEstadoTelegram(dados);

  console.log(
    [
      "[Recuperação] concluída",
      `conversas recuperadas: ${dados.conversas.length}`,
      `encerradas por inatividade: ${dados.encerradosPorInatividade}`,
      `resumos no lock: ${telegram.resumos}`,
      `resumos fora do TTL/grupo: ${telegram.descartados}`,
      `resumos a publicar: ${dados.resumosNaoPublicados.length}`,
      `vendedores: ${telegram.vendedores}`,
      `tempo: ${Date.now() - inicio} ms`,
    ].join(" | "),
  );

  return {
    ok: true,
    conversas: dados.conversas.length,
    resumosNaoPublicados: dados.resumosNaoPublicados,
  };
}

/**
 * Vendedor venceu o lock no Telegram: a IA para de responder
 * essa conversa.
 *
 * A linha do banco (vendedor, HUMANO, encerrado_em) já foi
 * gravada pela assunção em telegramBot.ts (Passo 5c). A
 * conversa continua em memória como HUMANO.
 */
function marcarAssumidoNaMemoria(atendimentoId: string): void {
  for (const conversa of conversas.values()) {
    if (conversa.atendimentoId !== atendimentoId) {
      continue;
    }

    conversa.vendedorAssumiu = true;

    marcarEncaminhada(conversa);

    console.log(`Atendimento ${atendimentoId} assumido por vendedor via Telegram.`);

    return;
  }

  console.log(
    `Atendimento ${atendimentoId} assumido via Telegram; conversa já encerrada na memória.`,
  );
}

/**
 * Somente para testes: zera a memória do webhook e do Telegram
 * (simula o processo morrendo antes de uma nova recuperação).
 */
export function redefinirEstadoWebhookParaTestes(): void {
  conversas.clear();

  conversationQueues.clear();

  for (const lote of lotesPendentes.values()) {
    if (lote.timer) {
      clearTimeout(lote.timer);
    }
  }

  lotesPendentes.clear();

  tarefasNaFila.clear();

  descartesSeguidos.clear();

  avisosLojaFechada.clear();

  definirDiasFechados([]);

  fechamentosPendentes = false;

  definirAberturaManual(null);

  aberturaPendente = false;

  redefinirEstadoTelegramParaTestes();

  definirAoAssumirAtendimento(marcarAssumidoNaMemoria);

  definirEnvioAoCliente(enviarAvisoAoCliente);
}

/*
 * Desligamento ordenado (SIGTERM/SIGINT). Enquanto encerra, toda
 * requisição recebe 503 (a Meta e o Telegram reenviam depois).
 */
const LIMITE_DESLIGAMENTO_MS = 45_000;

let encerrando = false;

let servidor: Server | null = null;

/*
 * Requisições já aceitas (passaram do teste de "encerrando") e
 * updates do Telegram em processamento.
 */
let requisicoesEmAndamento = 0;

const atualizacoesTelegram = new Set<Promise<void>>();

const esperar = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function trabalhoEmAndamento(): number {
  return requisicoesEmAndamento + lotesPendentes.size + conversationQueues.size + atualizacoesTelegram.size;
}

/**
 * Para de aceitar webhooks, espera (até limiteMs) as requisições
 * aceitas, as filas das conversas e os updates do Telegram, fecha o
 * servidor e o banco e sai. Limite estourado: sai assim mesmo (o que
 * estava na fila se perde, como num reinício).
 */
async function desligar(sinal: string, limiteMs: number): Promise<void> {
  encerrando = true;

  /*
   * Mensagens esperando o agrupamento vão para a fila agora.
   */
  fecharTodosOsLotes();

  console.log(`[Desligamento] ${sinal} recebido: webhooks recusados com 503; esperando o trabalho em andamento (até ${limiteMs / 1000} s).`);

  /*
   * O servidor segue ouvindo durante a espera: quem chegar recebe
   * 503 (e não conexão recusada).
   */
  let limiteEstourado = false;

  const limite = esperar(limiteMs).then(() => {
    limiteEstourado = true;
  });

  while (trabalhoEmAndamento() > 0 && !limiteEstourado) {
    await Promise.race([limite, esperar(100)]);
  }

  if (limiteEstourado && trabalhoEmAndamento() > 0) {
    console.error(
      `[Desligamento] ATENÇÃO: limite de ${limiteMs / 1000} s atingido com ${conversationQueues.size} conversa(s) e ${atualizacoesTelegram.size} update(s) do Telegram em andamento; saindo assim mesmo.`,
    );
  } else {
    console.log("[Desligamento] trabalho em andamento concluído.");
  }

  servidor?.close();

  servidor?.closeAllConnections();

  await Promise.race([
    encerrarBanco().catch((erro: unknown) => {
      console.error(`[Desligamento] falha ao fechar o banco (${descreverErro(erro)}).`);
    }),
    esperar(5_000),
  ]);

  console.log("[Desligamento] banco fechado; saindo.");

  process.exit(0);
}

/**
 * Instala o desligamento ordenado em SIGTERM (systemd) e SIGINT
 * (Ctrl+C). Um segundo sinal sai na hora.
 */
export function instalarDesligamentoOrdenado(limiteMs = LIMITE_DESLIGAMENTO_MS): void {
  const aoSinal = (sinal: NodeJS.Signals) => {
    if (encerrando) {
      console.error(`[Desligamento] ${sinal} de novo: saindo agora.`);

      process.exit(1);
    }

    void desligar(sinal, limiteMs);
  };

  process.on("SIGTERM", aoSinal);

  process.on("SIGINT", aoSinal);
}

/**
 * Inicia o servidor do webhook.
 */
export async function iniciarWebhook(): Promise<void> {
  definirAoAssumirAtendimento(marcarAssumidoNaMemoria);

  definirEnvioAoCliente(enviarAvisoAoCliente);

  const server = createServer(async (request, response) => {
    /*
     * Desligando: nada novo entra (503, para reenviarem depois).
     */
    if (encerrando) {
      response.setHeader("Connection", "close");

      responderJson(response, 503, { error: "Shutting down" });

      return;
    }

    requisicoesEmAndamento++;

    try {
      /*
       * Health check.
       */
      if (request.method === "GET" && request.url === "/health") {
        responderJson(response, 200, {
          ok: true,
        });

        return;
      }

      /*
       * Webhook da WhatsApp Cloud API (Meta).
       */
      const urlMeta = new URL(request.url ?? "/", "http://localhost");

      /*
       * Webhook do bot do Telegram (vendedores).
       */
      if (urlMeta.pathname === "/telegram/webhook") {
        if (request.method !== "POST") {
          responderJson(response, 405, { error: "Method not allowed" });

          return;
        }

        if (
          !segredoWebhookTelegramValido(
            request.headers["x-telegram-bot-api-secret-token"],
          )
        ) {
          responderJson(response, 401, { received: false });

          return;
        }

        const rawBodyTelegram = await lerCorpo(request);

        let update: TelegramUpdate;

        try {
          update = JSON.parse(rawBodyTelegram.toString("utf8")) as TelegramUpdate;
        } catch {
          responderJson(response, 400, { received: false });

          return;
        }

        /*
         * Responde rápido; processa em seguida.
         */
        responderJson(response, 200, { received: true });

        const atualizacao: Promise<void> = processarUpdateTelegram(update)
          .catch((erro: unknown) => {
            console.error(
              "Erro ao processar update do Telegram:",
              descreverErro(erro),
            );
          })
          .finally(() => {
            atualizacoesTelegram.delete(atualizacao);
          });

        atualizacoesTelegram.add(atualizacao);

        return;
      }

      if (urlMeta.pathname === "/meta/webhook") {
        if (request.method === "GET") {
          const verificacao = verificarDesafioMeta(urlMeta.searchParams);

          response.statusCode = verificacao.statusCode;

          response.setHeader("Content-Type", "text/plain; charset=utf-8");

          response.end(verificacao.body);

          return;
        }

        if (request.method === "POST") {
          const rawBodyMeta = await lerCorpo(request);

          const signatureMeta = request.headers["x-hub-signature-256"];

          if (
            typeof signatureMeta !== "string" ||
            !verificarAssinaturaMeta(rawBodyMeta, signatureMeta)
          ) {
            responderJson(response, 401, {
              received: false,
            });

            return;
          }

          let payloadMeta: MetaWebhookPayload;

          try {
            payloadMeta = JSON.parse(
              rawBodyMeta.toString("utf8"),
            ) as MetaWebhookPayload;
          } catch {
            responderJson(response, 400, {
              received: false,
            });

            return;
          }

          /*
           * Deduplicação persistente das mensagens recebidas
           * (messages[]) ANTES de responder. statuses[] NÃO passa
           * por aqui: trazem o mesmo wamid da mensagem original.
           */
          const mensagensNovas: EventoMensagem[] = [];

          let falhaRegistro = false;

          for (const evento of normalizarMensagensMeta(payloadMeta)) {
            const registro = await registrarMensagemRecebida(
              "META",
              chaveEventoExterno(evento),
              evento,
            );

            if (registro === "processar") {
              mensagensNovas.push(evento);
            } else if (registro === "falha") {
              falhaRegistro = true;
            }
          }

          /*
           * Falha ao registrar: 5xx para a Meta reenviar. As
           * mensagens registradas nesta mesma entrega seguem
           * normalmente (no reenvio serão duplicatas).
           */
          responderJson(response, falhaRegistro ? 503 : 200, {
            received: !falhaRegistro,
          });

          processarPayloadMeta(payloadMeta);

          /*
           * statuses[] são o resultado posterior
           * do envio (sent, delivered, read, failed).
           */
          for (const status of listarStatusesMeta(payloadMeta)) {
            try {
              tratarStatusMeta(status);
            } catch (erro: unknown) {
              console.error(
                "Erro ao tratar status da Meta:",
                descreverErro(erro),
              );
            }
          }

          /*
           * messages[] entram no núcleo de atendimento.
           *
           * ORDEM DO LOTE: a ordem original do payload DEVE ser
           * preservada. Não pode existir await entre esta iteração
           * e adicionarNaFila (processarEvento →
           * processarMensagemRecebida), nem Promise.all aqui: as
           * mensagens entram na fila da conversa, de forma
           * síncrona, na ordem do laço. Qualquer mudança neste
           * fluxo precisa preservar essa regra
           * (teste: passo3-ordem-lote.test.mts).
           */
          for (const evento of mensagensNovas) {
            processarEvento(evento).catch((erro: unknown) => {
              console.error(
                "Erro ao processar mensagem da Meta:",
                descreverErro(erro),
              );
            });
          }

          return;
        }
      }

      /*
       * Qualquer outra rota.
       */
      responderJson(response, 404, {
        error: "Not found",
      });
    } catch (erro: unknown) {
      if (!response.headersSent) {
        responderJson(response, 500, {
          received: false,
        });
      }

      console.error(
        "Erro interno no webhook:",
        descreverErro(erro),
      );
    } finally {
      requisicoesEmAndamento--;
    }
  });

  servidor = server;

  /*
   * ORDEM DA PARTIDA (Passo 5d): a recuperação termina ANTES do
   * listen, para nenhuma mensagem chegar numa memória vazia (a
   * Meta e o Telegram reenviam o que não foi aceito). Banco fora
   * ou lento: sobe com a memória vazia, como antes.
   */
  const recuperacao = await recuperarNaPartida();

  /*
   * Mensagens que esperavam processamento quando o processo caiu.
   */
  await reprocessarMensagensPendentes();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);

    const host = hostDeEscuta();

    const aoOuvir = () => {
      server.off("error", reject);

      console.log(`Backend ouvindo na porta ${PORT}${host ? ` (somente ${host})` : ""}`);

      console.log("Endpoint: GET/POST /meta/webhook");

      console.log("Endpoint: POST /telegram/webhook");

      resolve();
    };

    if (host) {
      server.listen(PORT, host, aoOuvir);
    } else {
      server.listen(PORT, aoOuvir);
    }
  });

  /*
   * Pendências do Telegram (resumos não publicados, DMs não
   * entregues): depois do listen, sem bloquear a partida.
   */
  if (recuperacao.ok) {
    reenviarPendenciasRecuperadas(recuperacao.resumosNaoPublicados)
      .then(({ resumos, dms }) => {
        console.log(`[Recuperação] pendências reenviadas | resumos publicados: ${resumos} | DMs reenviadas: ${dms}`);
      })
      .catch((erro: unknown) => {
        console.error(`[Recuperação] falha ao reenviar pendências (${descreverErro(erro)}).`);
      });
  }

  /*
   * Menu de comandos do bot (idempotente; falha só gera aviso no log).
   */
  registrarMenuComandos().catch((erro: unknown) => {
    console.warn(`[Telegram] aviso: menu de comandos não registrado (${descreverErro(erro)}).`);
  });

  /*
   * Retenção de dados (LGPD): agora, sem bloquear, e a cada 24 h.
   */
  agendarRetencao();

  /*
   * Verifica inatividade a cada 30 segundos
   * (vale também para as conversas recuperadas).
   */
  setInterval(verificarInatividade, VERIFICACAO_INATIVIDADE_MS);

  /*
   * Conversas recuperadas em que o cliente já tinha parado: vão ao
   * vendedor agora, antes de uma mensagem nova encontrá-las.
   */
  verificarInatividade();

  /*
   * Resumo sem ninguém assumir há 5 min: lembrete no grupo (uma vez).
   */
  setInterval(() => {
    verificarLembretesSemAssumir().catch((erro: unknown) => {
      console.error("Erro ao verificar lembretes de resumo sem assumir:", descreverErro(erro));
    });
  }, VERIFICACAO_INATIVIDADE_MS);

  /*
   * Abertura manual vencida: sai da memória e o grupo é avisado.
   */
  setInterval(() => {
    verificarFimAberturaManual().catch((erro: unknown) => {
      console.error("Erro ao encerrar a abertura manual:", descreverErro(erro));
    });
  }, VERIFICACAO_INATIVIDADE_MS);

  /*
   * Fechamentos que não carregaram na partida (banco fora).
   */
  setInterval(() => {
    void tentarCarregarFechamentos();

    void tentarCarregarAberturaManual();
  }, 60_000);

  setInterval(() => {
    /*
     * Faxina do grupo: resumo assumido há 30 min sai do grupo.
     */
    apagarResumosAssumidos().catch((erro: unknown) => {
      console.error("Erro ao apagar resumos assumidos do grupo:", descreverErro(erro));
    });

    reenviarResumosTelegramPendentes().catch((erro: unknown) => {
      console.error(
        "Erro ao reenviar resumos do Telegram:",
        descreverErro(erro),
      );
    });

    /*
     * Gravações do Telegram que falharam no banco.
     */
    regravarPendenciasBanco().catch((erro: unknown) => {
      console.error("Erro ao regravar pendências no banco:", descreverErro(erro));
    });
  }, 60_000);
}
