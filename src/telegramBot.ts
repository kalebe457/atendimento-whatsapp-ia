import { createHash, timingSafeEqual } from "node:crypto";

import {
  RegistroAtendimentosVendedor,
  ResultadoAssumir,
} from "./atendimentoVendedor.js";

import { descreverErro, mascararIdTelegram, mascararTelefone } from "./logSeguro.js";

import {
  consultarRanking,
  marcarAvisoAssuncao,
  registrarAssuncao,
  registrarDmStatus,
  registrarResumoPublicado,
  registrarVendedor,
  reservarAvisoAssuncao,
  reservarLembreteSemAssumir,
  gravarLembreteMensagem,
  anexarRepasseGrupo,
  limparRepassesGrupo,
  marcarResumoApagado,
  type RepasseGrupo,
  type DadosAssuncao,
  type DadosVendedor,
} from "./persistenciaAssuncao.js";

import type {
  ResumoRecuperado,
  VendedorRecuperado,
} from "./persistenciaRecuperacao.js";

import { linhasDeItens, pedidoEmTexto } from "./itensPedido.js";

import type { ResumoCliente } from "./tipos.js";

import {
  adicionarDiaFechado,
  dataLocal,
  listarDiasFechados,
  lojaAberta,
  removerDiaFechado,
  aberturaManualAtiva,
  aberturaManualRegistrada,
  definirAberturaManual,
  horarioDaLoja,
  type AberturaManual,
} from "./horarioFuncionamento.js";

import {
  apagarFechamento,
  cancelarAberturaManual,
  gravarAberturaManual,
  gravarFechamento,
} from "./persistenciaFechamentos.js";

/*
 * Integração dos vendedores pelo Telegram.
 *
 * - O resumo vai para o grupo com o botão ASSUMIR.
 * - Quem pode ser vendedor: quem está no grupo dos
 *   vendedores (getChatMember), conferido no /start
 *   e de novo em cada clique em ASSUMIR.
 * - O vendedor se registra mandando /start ao bot
 *   no privado (só o user_id, o nome do Telegram e
 *   o chat privado são guardados).
 * - Quem vence o lock recebe, SOMENTE no privado,
 *   os dados do cliente e o botão wa.me.
 *
 * A memória (vendedores, atendimentos, lock) é a fonte de
 * verdade. O banco registra o resumo publicado, a assunção e a
 * DM, e é um segundo portão contra assunção dupla (Passo 5c).
 *
 * /ranking (só no privado, só administradores do grupo):
 * atendimentos assumidos por vendedor, no mês e no total.
 * /fechar, /abrir e /fechamentos (idem): fechamento manual da loja.
 */

const TELEGRAM_API = "https://api.telegram.org";

const CALLBACK_ASSUMIR = /^assumir:(ATD-[0-9A-F]{10})$/;

/*
 * Textos da assunção que chegam ao CLIENTE (um lugar só):
 * - o aviso pelo número da loja quando um vendedor assume;
 * - a mensagem pronta do link wa.me da DM (o vendedor envia, se quiser).
 * Nenhum dos dois vai para os logs.
 */
const NOME_LOJA = "Exemplo Materiais de Construção";

const LIMITE_PEDIDO_LINK = 150;

function campoInformado(valor: string | null | undefined): string | null {
  const texto = (valor ?? "").replace(/\s+/g, " ").trim();

  return texto === "" || texto === "Não informado" ? null : texto;
}

/*
 * Nome do cliente nas mensagens: o que ele informou; muito longo, só a
 * primeira palavra.
 */
function nomeDoCliente(nome: string | null | undefined): string | null {
  const texto = campoInformado(nome);

  return texto && texto.length > 40 ? (texto.split(" ")[0] ?? null) : texto;
}

/*
 * Primeiro nome do vendedor para o cliente, a partir do nome guardado do
 * Telegram: sem emojis nem símbolos (ficam letras, inclusive acentuadas,
 * e hífen/apóstrofo dentro do nome), espaços juntados, a primeira palavra
 * com letra. "Paulo 🔥" → "Paulo"; "João-Pedro" → "João-Pedro";
 * "Ana Luísa" → "Ana". Sem nome de verdade (só @usuário, o "Vendedor"
 * padrão ou nada com letra): null.
 */
export function primeiroNomeVendedor(nome: string | null | undefined): string | null {
  const bruto = campoInformado(nome);

  if (!bruto || bruto.startsWith("@") || bruto === "Vendedor") {
    return null;
  }

  const limpo = bruto
    .normalize("NFC")
    .replace(/[\u200d\ufe0e\ufe0f]/g, "")
    .replace(/[^\p{L}\p{M}\s'’-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const palavra of limpo.split(" ")) {
    const semPontas = palavra.replace(/^['’-]+|['’-]+$/g, "");

    if (/\p{L}/u.test(semPontas)) {
      return semPontas;
    }
  }

  return null;
}

/**
 * Aviso ao cliente quando o vendedor assume (loja aberta ou fechada).
 * Sem artigo nem gênero antes do nome (há vendedores e vendedoras).
 */
export function textoAvisoAssuncao(nomeCliente: string | null | undefined, nomeVendedor: string | null | undefined, aberta: boolean): string {
  const cliente = nomeDoCliente(nomeCliente);

  const vendedor = primeiroNomeVendedor(nomeVendedor);

  const pronto = cliente ? `Pronto, ${cliente}!` : "Pronto!";

  const quem = vendedor ? `${vendedor}, da nossa equipe de vendas,` : "Um vendedor da loja";

  const quando = aberta ? "vai te chamar pelo WhatsApp em instantes" : "vai te chamar no próximo horário de atendimento";

  return `${pronto} ${quem} já está com o seu pedido e ${quando}.`;
}

/**
 * Mensagem pronta do link wa.me da DM (o vendedor abre o WhatsApp com
 * ela preenchida). Trecho do pedido limitado a ~150 caracteres.
 */
export function textoMensagemWaMe(resumo: Pick<ResumoCliente, "nome" | "produto" | "quantidade">, nomeVendedor: string | null | undefined): string {
  const cliente = nomeDoCliente(resumo.nome);

  const vendedor = primeiroNomeVendedor(nomeVendedor);

  const trecho = pedidoEmTexto(resumo.produto, resumo.quantidade);

  const saudacao = cliente ? `Olá, ${cliente}!` : "Olá!";

  /* Sem artigo antes do nome (há vendedores e vendedoras). */
  const apresentacao = vendedor ? `Aqui é ${vendedor}, da loja ${NOME_LOJA}.` : `Aqui é da loja ${NOME_LOJA}.`;

  let pedido = "Vi que você entrou em contato com a loja.";

  if (trecho) {
    const caracteres = Array.from(trecho);

    pedido =
      caracteres.length > LIMITE_PEDIDO_LINK
        ? `Vi seu pedido de ${caracteres.slice(0, LIMITE_PEDIDO_LINK - 3).join("").trimEnd()}...`
        : `Vi seu pedido de ${trecho}.`;
  }

  return `${saudacao} ${apresentacao} ${pedido} Vamos fazer seu orçamento?`;
}

const MENSAGEM_ONBOARDING =
  "Antes de assumir um atendimento, abra @ExemploAtendimentoBot no privado e envie /start.";

const MENSAGEM_INDISPONIVEL = "Este atendimento não está mais disponível.";

const MENSAGEM_FORA_DA_EQUIPE =
  "Você não faz parte da equipe de vendedores da loja Exemplo Materiais de Construção.";

const MENSAGEM_VERIFICACAO_FALHOU =
  "Não consegui verificar sua participação na equipe agora. Tente novamente em instantes.";

const MENSAGEM_SO_ADMIN = "Esse comando é só para administradores do grupo.";

const MENSAGEM_RANKING_VAZIO = "Nenhum atendimento assumido ainda.";

const MENSAGEM_RANKING_ERRO = "Não consegui consultar agora. Tente de novo em instantes.";

/*
 * Topo do resumo quando a IA não conseguiu responder o cliente.
 */
/*
 * Limite de texto do sendMessage/editMessageText é 4096 caracteres.
 * Cada campo do cliente vai cortado em LIMITE_CAMPO (contado em
 * unidades UTF-16, sem partir emoji): 4 campos × 900 + cabeçalhos
 * e aviso ficam abaixo de 4096. Só a mensagem é cortada: memória
 * e banco guardam o texto inteiro.
 */
export const LIMITE_TEXTO_TELEGRAM = 4096;

const LIMITE_CAMPO = 900;

const MARCA_CORTE = "… (cortado)";

/**
 * Corta um texto em no máximo `limite` unidades UTF-16, sem
 * partir um par substituto (emoji), com a marca de corte no fim.
 */
export function cortarTexto(texto: string, limite: number): string {
  if (texto.length <= limite) {
    return texto;
  }

  let fim = Math.max(0, limite - MARCA_CORTE.length);

  const ultimo = texto.charCodeAt(fim - 1);

  if (ultimo >= 0xd800 && ultimo <= 0xdbff) {
    fim--;
  }

  return texto.slice(0, fim) + MARCA_CORTE;
}

const campo = (valor: string): string => cortarTexto(valor, LIMITE_CAMPO);

const AVISO_FALHA_ENVIO =
  "⚠️ A IA não conseguiu responder este cliente. Assuma e fale com ele pelo WhatsApp.";

/*
 * Tempo máximo da consulta ao grupo: uma API lenta não
 * pode deixar o /start ou o callback presos.
 */
const TIMEOUT_GET_CHAT_MEMBER_MS = 5_000;

/*
 * Quem está no grupo dos vendedores (TELEGRAM_CHAT_ID) com
 * um destes status pode atuar como vendedor. É a ÚNICA fonte
 * de autorização. "restricted", "left" e "kicked" não valem.
 */
const STATUS_AUTORIZADOS = new Set(["member", "administrator", "creator"]);

/*
 * Quem pode usar o /ranking.
 */
const STATUS_ADMINISTRADORES = new Set(["administrator", "creator"]);

/*
 * Alerta aos administradores quando o Telegram recusa o resumo com
 * 403 (bot removido do grupo ou sem permissão): no máximo 1 a cada
 * 30 min, sem dado de cliente. DM recusada por UM vendedor não entra
 * aqui (o grupo já mostra o aviso).
 */
const MENSAGEM_GRUPO_INACESSIVEL =
  "⚠️ O bot não consegue publicar no grupo de vendedores (sem permissão ou removido). Os resumos não estão chegando.";

const INTERVALO_ALERTA_GRUPO_MS = 30 * 60 * 1000;

let ultimoAlertaGrupoEm: number | null = null;

let filaAlertaGrupo: Promise<void> = Promise.resolve();

/*
 * Administradores vistos por último (getChatAdministrators bem-sucedido
 * ou getChatMember com administrator/creator). Usados quando o grupo
 * não pode ser consultado (bot removido). Só em memória.
 */
let administradoresConhecidos = new Set<string>();

/*
 * Atendimentos mais antigos que isso saem
 * da memória (o lock expira em 24h).
 */
const RETENCAO_ATENDIMENTO_MS = 48 * 60 * 60 * 1000;

const MAX_ATENDIMENTOS = 5_000;

const MAX_IDS_PROCESSADOS = 2_000;

function config(): { token: string; chatId: string; segredo: string } {
  return {
    token: (process.env.TELEGRAM_BOT_TOKEN ?? "").trim(),

    chatId: (process.env.TELEGRAM_CHAT_ID ?? "").trim(),

    segredo: (process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim(),
  };
}

/**
 * O envio para o grupo está configurado?
 */
export function telegramConfigurado(): boolean {
  const { token, chatId } = config();

  return token !== "" && chatId !== "";
}

/*
 * Tipos mínimos da Bot API usados aqui.
 */
type TelegramUsuario = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramChat = {
  id: number;
  type?: string;
};

type TelegramMensagem = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUsuario;
  text?: string;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUsuario;
  message?: TelegramMensagem;
  data?: string;
};

export type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMensagem;
  callback_query?: TelegramCallbackQuery;
};

type RespostaTelegram<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
};

type Vendedor = {
  userId: string;

  /*
   * Nome como aparece no Telegram.
   */
  nome: string;

  chatPrivadoId: number;
};

type EstadoDM = "pendente" | "enviando" | "enviada" | "falhou";

type AtendimentoTelegram = {
  atendimentoId: string;

  chatIdCliente: string;

  resumo: ResumoCliente;

  /*
   * "recusado": o Telegram devolveu 4xx (exceto 429). Repetir o
   * mesmo pedido daria o mesmo erro, então não é reenviado.
   */
  envioResumo: "enviando" | "enviado" | "falhou" | "recusado";

  /*
   * O resumo sai com o aviso de que a IA não conseguiu
   * responder o cliente (vale também para os reenvios).
   */
  avisoFalhaEnvio: boolean;

  /*
   * O cliente parou de responder e a triagem foi encerrada nesta etapa
   * (linha de aviso no resumo); null = não.
   */
  etapaParada: string | null;

  /*
   * Quando o resumo foi publicado no grupo (null = ainda não).
   */
  publicadoEm: number | null;

  /*
   * O lembrete "sem assumir há 20 min" já foi dado (o banco guarda
   * entre reinícios).
   */
  lembreteSemAssumir: boolean;

  /*
   * message_id do resumo no grupo. Só cliques
   * nessa mensagem são aceitos.
   */
  mensagemGrupoId: number | null;

  vendedorId: string | null;

  vendedorNome: string | null;

  dm: EstadoDM;

  criadoEm: number;

  /*
   * O aviso ao cliente da assunção já foi tentado neste processo
   * (o banco garante uma vez só entre reinícios).
   */
  avisoClienteFeito: boolean;

  /*
   * Faxina do grupo (o banco guarda entre reinícios, sql/009): o lembrete
   * ainda no grupo, as mensagens do cliente repassadas ao grupo antes de
   * alguém assumir, quando foi assumido e se o resumo já saiu do grupo.
   */
  lembreteMensagemId: number | null;

  repassesGrupo: RepasseGrupo[];

  assumidoEm: number | null;

  resumoApagado: boolean;
};

/**
 * user_id do Telegram como identidade do vendedor.
 */
function normalizarIdTelegram(valor: unknown): string {
  if (typeof valor === "number" && Number.isSafeInteger(valor) && valor > 0) {
    return String(valor);
  }

  if (typeof valor === "string" && /^\d{1,20}$/.test(valor)) {
    return valor;
  }

  return "";
}

/*
 * Estado do módulo.
 */
let vendedores = new Map<string, Vendedor>();

let atendimentos = new Map<string, AtendimentoTelegram>();

let idsProcessados = new Set<string>();

/*
 * O MESMO lock de atendimentoVendedor.ts. Para ele,
 * "autorizado" = registrado pelo /start (precisa do chat
 * privado para a DM). A autorização de verdade (grupo)
 * é conferida ANTES de chamar o lock.
 */
let lock = criarLock();

function criarLock(): RegistroAtendimentosVendedor {
  return new RegistroAtendimentosVendedor({
    vendedoresAutorizados: () => new Set(vendedores.keys()),

    normalizarVendedor: normalizarIdTelegram,
  });
}

/*
 * Envio ao cliente pelo número da loja (Meta), registrado pelo webhook.
 * "somente_log" = META_ENVIO_ATIVO=false (não enviado de propósito).
 */
export type ResultadoEnvioCliente = "enviado" | "somente_log" | "falhou";

type EnviarAoCliente = (chatIdCliente: string, texto: string) => Promise<ResultadoEnvioCliente>;

let enviarAoClienteGancho: EnviarAoCliente | null = null;

export function definirEnvioAoCliente(funcao: EnviarAoCliente): void {
  enviarAoClienteGancho = funcao;
}

type AoAssumir = (atendimentoId: string) => void;

let aoAssumir: AoAssumir = () => undefined;

/**
 * Chamado quando um vendedor vence o lock.
 * O webhook usa para marcar a conversa como HUMANO.
 */
export function definirAoAssumirAtendimento(funcao: AoAssumir): void {
  aoAssumir = funcao;
}

/**
 * Somente para testes: zera o estado em memória.
 */
export function redefinirEstadoTelegramParaTestes(): void {
  pendenciasBanco = new Map();

  ultimoAlertaGrupoEm = null;

  filaAlertaGrupo = Promise.resolve();

  administradoresConhecidos = new Set();

  vendedores = new Map();

  atendimentos = new Map();

  idsProcessados = new Set();

  lock = criarLock();

  aoAssumir = () => undefined;

  enviarAoClienteGancho = null;
}

/*
 * Gravações no banco que falharam (vendedor do /start, resumo
 * publicado, assunção e resultado da DM). A memória já vale; o banco
 * é regravado a cada minuto (regravarPendenciasBanco) até conseguir.
 * Uma por chave: a mais nova substitui a anterior, e uma gravação
 * direta bem-sucedida apaga a pendente. Expiram em 24 h e se perdem
 * num reinício.
 */
type PendenciaBanco =
  | { tipo: "vendedor"; dados: DadosVendedor }
  | { tipo: "resumo"; codigo: string; telegramChatId: number | string; telegramMessageId: number; publicadoEm: Date }
  | { tipo: "assuncao"; dados: DadosAssuncao & { assumidoEm: Date } }
  | { tipo: "dm"; codigo: string; status: "ENVIADA" | "FALHOU" }
  | { tipo: "aviso"; codigo: string; em: Date };

/*
 * Ordem da regravação: o vendedor e o resumo antes da assunção,
 * e a assunção antes da DM (a DM só grava atendimento assumido).
 */
const ORDEM_PENDENCIAS = ["vendedor", "resumo", "assuncao", "dm", "aviso"] as const;

const VALIDADE_PENDENCIA_MS = 24 * 60 * 60 * 1000;

let pendenciasBanco = new Map<string, { pendencia: PendenciaBanco; desde: number }>();

function chavePendencia(p: PendenciaBanco): string {
  switch (p.tipo) {
    case "vendedor":
      return `vendedor:${p.dados.telegramUserId}`;

    case "assuncao":
      return `assuncao:${p.dados.codigo}`;

    default:
      return `${p.tipo}:${p.codigo}`;
  }
}

function descreverPendencia(p: PendenciaBanco): string {
  switch (p.tipo) {
    case "vendedor":
      return `vendedor ${mascararIdTelegram(p.dados.telegramUserId)}`;

    case "assuncao":
      return `assunção de ${p.dados.codigo}`;

    default:
      return `${p.tipo} de ${p.codigo}`;
  }
}

/**
 * Resultado de uma gravação no banco: gravou (apaga a pendente
 * dessa chave) ou falhou (fica pendente, substituindo a anterior).
 */
function anotarGravacao(p: PendenciaBanco, gravou: boolean): void {
  const chave = chavePendencia(p);

  if (gravou) {
    pendenciasBanco.delete(chave);

    return;
  }

  const anterior = pendenciasBanco.get(chave);

  pendenciasBanco.set(chave, { pendencia: p, desde: anterior?.desde ?? Date.now() });

  if (!anterior) {
    console.error(`[Persistência] ${descreverPendencia(p)} pendente no banco; nova tentativa a cada minuto.`);
  }
}

/*
 * "erro": falha de banco (para a rodada); "esperar": depende de outra
 * pendência; "descartar": não vale mais gravar.
 */
async function regravar(p: PendenciaBanco): Promise<"gravado" | "erro" | "esperar" | "descartar"> {
  switch (p.tipo) {
    case "vendedor":
      return (await registrarVendedor(p.dados)) ? "gravado" : "erro";

    case "resumo":
      return (await registrarResumoPublicado(p.codigo, p.telegramChatId, p.telegramMessageId, p.publicadoEm)) === "erro"
        ? "erro"
        : "gravado";

    case "assuncao": {
      const resultado = await registrarAssuncao(p.dados);

      if (resultado === "erro") {
        return "erro";
      }

      if (resultado === "ja_por_outro") {
        console.error(
          `[Persistência] ATENÇÃO: ${p.dados.codigo}: o banco já registra OUTRO vendedor; a assunção feita pela memória não foi gravada.`,
        );

        /*
         * A DM pendente era deste vendedor: não pode ir para a linha do outro.
         */
        pendenciasBanco.delete(`dm:${p.dados.codigo}`);

        return "descartar";
      }

      /*
       * A assunção gravada volta com dm_status ENVIANDO: grava em
       * seguida o resultado da DM que a memória já tem.
       */
      const atd = atendimentos.get(p.dados.codigo);

      if (resultado !== "sem_linha" && atd?.vendedorId === p.dados.telegramUserId && (atd.dm === "enviada" || atd.dm === "falhou")) {
        const dm: PendenciaBanco = { tipo: "dm", codigo: atd.atendimentoId, status: atd.dm === "enviada" ? "ENVIADA" : "FALHOU" };

        anotarGravacao(dm, await registrarDmStatus(dm.codigo, dm.status));
      }

      return "gravado";
    }

    case "dm":
      if (pendenciasBanco.has(`assuncao:${p.codigo}`)) {
        return "esperar";
      }

      return (await registrarDmStatus(p.codigo, p.status)) ? "gravado" : "erro";

    case "aviso":
      return (await marcarAvisoAssuncao(p.codigo, p.em)) ? "gravado" : "erro";
  }
}

/**
 * Regrava no banco o que falhou (chamada a cada minuto). Para na
 * primeira falha de banco: o resto fica para a próxima rodada.
 * Devolve quantas foram gravadas.
 */
export async function regravarPendenciasBanco(agora = Date.now()): Promise<number> {
  let gravadas = 0;

  for (const tipo of ORDEM_PENDENCIAS) {
    for (const [chave, item] of [...pendenciasBanco]) {
      if (item.pendencia.tipo !== tipo || pendenciasBanco.get(chave) !== item) {
        continue;
      }

      if (agora - item.desde >= VALIDADE_PENDENCIA_MS) {
        pendenciasBanco.delete(chave);

        console.error(`[Persistência] ATENÇÃO: ${descreverPendencia(item.pendencia)} não gravado no banco em 24 h; desistindo (vale a memória).`);

        continue;
      }

      const resultado = await regravar(item.pendencia);

      /*
       * Substituída durante a gravação: a mais nova fica.
       */
      if (pendenciasBanco.get(chave) !== item) {
        continue;
      }

      if (resultado === "erro") {
        return gravadas;
      }

      if (resultado === "esperar") {
        continue;
      }

      pendenciasBanco.delete(chave);

      if (resultado === "gravado") {
        gravadas++;

        console.log(`[Persistência] ${descreverPendencia(item.pendencia)} regravado no banco.`);
      }
    }
  }

  return gravadas;
}

/**
 * Somente para testes: quantas gravações estão pendentes.
 */
export function quantasPendenciasBanco(): number {
  return pendenciasBanco.size;
}

function resumoRecuperado(r: ResumoRecuperado): ResumoCliente {
  return {
    nome: r.nome ?? "Não informado",
    telefone: r.telefone,
    produto: r.produto ?? "Não informado",
    quantidade: r.quantidade ?? "Não informado",
    observacoes: r.observacoes ?? "Não informado",
  };
}

/**
 * Recuperação na partida (Passo 5d): devolve à memória os
 * vendedores e os resumos publicados dentro do TTL, para o
 * botão ASSUMIR continuar valendo. Os TTLs do lock contam dos
 * horários reais. DM que não consta como ENVIADA (ENVIANDO ou
 * FALHOU) volta como "falhou" e é reenviada depois.
 */
export function restaurarEstadoTelegram(dados: {
  vendedores: VendedorRecuperado[];
  resumosPublicados: ResumoRecuperado[];
}): { vendedores: number; resumos: number; descartados: number } {
  let quantosVendedores = 0;

  for (const v of dados.vendedores) {
    const userId = normalizarIdTelegram(v.userId);

    if (!userId || !Number.isSafeInteger(v.chatPrivadoId)) {
      continue;
    }

    vendedores.set(userId, { userId, nome: v.nome, chatPrivadoId: v.chatPrivadoId });

    quantosVendedores++;
  }

  let resumos = 0;

  let descartados = 0;

  for (const r of dados.resumosPublicados) {
    /*
     * Só cliques no grupo configurado valem.
     */
    if (
      r.telegramChatId !== config().chatId ||
      r.telegramMessageId === null ||
      r.resumoEnviadoEm === null ||
      atendimentos.has(r.codigo)
    ) {
      descartados++;

      continue;
    }

    if (!lock.restaurar(r.codigo, r.chatId, r.vendedorUserId, r.resumoEnviadoEm, r.assumidoEm)) {
      descartados++;

      continue;
    }

    atendimentos.set(r.codigo, {
      atendimentoId: r.codigo,
      chatIdCliente: r.chatId,
      resumo: resumoRecuperado(r),
      envioResumo: "enviado",
      avisoFalhaEnvio: false,
      etapaParada: null,
      publicadoEm: r.resumoEnviadoEm,
      lembreteSemAssumir: r.lembreteSemAssumirEm !== null,
      mensagemGrupoId: r.telegramMessageId,
      vendedorId: r.vendedorUserId,
      vendedorNome: r.vendedorNome,
      dm: r.dmStatus === "ENVIADA" ? "enviada" : r.dmStatus === null ? "pendente" : "falhou",
      criadoEm: r.resumoEnviadoEm,
      avisoClienteFeito: false,
      lembreteMensagemId: r.lembreteMensagemId,
      repassesGrupo: r.repassesGrupo,
      assumidoEm: r.assumidoEm,
      resumoApagado: r.resumoApagadoEm !== null,
    });

    resumos++;
  }

  return { vendedores: quantosVendedores, resumos, descartados };
}

/**
 * Depois da recuperação (sem bloquear a partida): publica os
 * resumos que ficaram sem publicar e reenvia as DMs que não
 * constam como enviadas.
 */
export async function reenviarPendenciasRecuperadas(
  naoPublicados: ResumoRecuperado[],
): Promise<{ resumos: number; dms: number }> {
  let resumos = 0;

  let dms = 0;

  if (!telegramConfigurado()) {
    return { resumos, dms };
  }

  for (const r of naoPublicados) {
    if (await enviarResumoTelegram(r.codigo, r.chatId, resumoRecuperado(r))) {
      resumos++;
    }
  }

  for (const atd of [...atendimentos.values()]) {
    if (atd.vendedorId === null || atd.dm !== "falhou") {
      continue;
    }

    const vendedor = vendedores.get(atd.vendedorId);

    if (!vendedor) {
      console.error(
        `[Recuperação] DM de ${atd.atendimentoId} não reenviada: vendedor sem chat privado registrado.`,
      );

      continue;
    }

    if (await enviarDMVencedor(atd, vendedor)) {
      dms++;

      await atualizarMensagemGrupo(atd);
    }
  }

  return { resumos, dms };
}

/**
 * Chama a Bot API. Nunca registra o token.
 */
async function chamarTelegram<T>(
  metodo: string,
  corpo: Record<string, unknown>,
  timeoutMs?: number,
): Promise<RespostaTelegram<T>> {
  const { token } = config();

  if (!token) {
    console.error(`[Telegram] ${metodo} não executado: TELEGRAM_BOT_TOKEN ausente.`);

    return { ok: false, description: "token ausente" };
  }

  try {
    const resposta = await fetch(`${TELEGRAM_API}/bot${token}/${metodo}`, {
      method: "POST",

      headers: { "Content-Type": "application/json" },

      body: JSON.stringify(corpo),

      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });

    const json = (await resposta.json()) as RespostaTelegram<T>;

    if (!json.ok) {
      console.error(
        // Sem a description: texto da API, pode ecoar o que foi enviado.
        `[Telegram] ${metodo} falhou | código: ${typeof json.error_code === "number" ? json.error_code : resposta.status}`,
      );
    }

    return json;
  } catch (erro: unknown) {
    const mensagem = descreverErro(erro);

    console.error(`[Telegram] ${metodo} falhou | rede: ${mensagem}`);

    return { ok: false, description: mensagem };
  }
}

/*
 * 400 cuja descrição indica que o bot não pode publicar no grupo (sem
 * permissão, grupo inexistente ou migrado). A descrição só é comparada,
 * nunca registrada no log.
 */
const DESCRICOES_GRUPO_INACESSIVEL =
  /not enough rights|chat not found|have no rights|CHAT_WRITE_FORBIDDEN|group chat was upgraded/i;

/**
 * O resumo foi recusado porque o bot não consegue publicar no grupo:
 * 403, ou 400 com uma das descrições acima. Outros 400 (ex.: texto
 * inválido) não contam.
 */
function grupoInacessivel(resposta: RespostaTelegram<unknown>): boolean {
  if (resposta.error_code === 403) {
    return true;
  }

  return (
    resposta.error_code === 400 &&
    typeof resposta.description === "string" &&
    DESCRICOES_GRUPO_INACESSIVEL.test(resposta.description)
  );
}

/**
 * 4xx do Telegram (exceto 429, limite de taxa): o mesmo pedido
 * daria o mesmo erro. Rede, 5xx e token ausente são passageiros.
 */
function erroPermanente(resposta: RespostaTelegram<unknown>): boolean {
  const codigo = resposta.error_code;

  return typeof codigo === "number" && codigo >= 400 && codigo < 500 && codigo !== 429;
}

/**
 * Link wa.me: só dígitos, formato internacional.
 * null quando o telefone não é utilizável.
 */
export function gerarLinkWhatsApp(telefone: string, texto?: string): string | null {
  const digitos = (telefone ?? "").replace(/\D/g, "");

  if (digitos.length < 10 || digitos.length > 15) {
    return null;
  }

  return texto ? `https://wa.me/${digitos}?text=${encodeURIComponent(texto)}` : `https://wa.me/${digitos}`;
}

/*
 * Telefone no GRUPO só mascarado: o completo (e o wa.me) vai
 * só na DM de quem assumir.
 */
function telefoneParaGrupo(telefone: string): string {
  const digitos = telefone.replace(/\D/g, "");

  return digitos.length >= 10 ? mascararTelefone(digitos) : "Não informado";
}

function formatarResumoGrupo(resumo: ResumoCliente, avisoFalhaEnvio = false, etapaParada: string | null = null): string {
  return cortarTexto([
    ...(avisoFalhaEnvio ? [AVISO_FALHA_ENVIO, ""] : []),
    ...(etapaParada ? [`⚠️ Cliente parou de responder na etapa: ${etapaParada}`, ""] : []),
    "📋 NOVO ATENDIMENTO",
    "",
    `Nome: ${campo(resumo.nome)}`,
    `Telefone: ${telefoneParaGrupo(resumo.telefone)}`,
    ...linhasDeItens(resumo.produto, resumo.quantidade, campo),
    `Observações: ${campo(resumo.observacoes)}`,
  ].join("\n"), LIMITE_TEXTO_TELEGRAM);
}

function formatarAssumidoGrupo(atd: AtendimentoTelegram): string {
  const linhas = ["🔒 ATENDIMENTO ASSUMIDO", "", `Vendedor: ${atd.vendedorNome ?? "-"}`];

  if (atd.dm === "falhou") {
    linhas.push(
      "",
      "⚠️ O atendimento foi assumido, mas houve erro ao enviar a mensagem privada ao vendedor. Para receber os dados, o vendedor deve enviar /start ao bot no privado.",
    );
  }

  return linhas.join("\n");
}

function formatarDM(resumo: ResumoCliente, link: string | null): string {
  const linhas = [
    "🔒 ATENDIMENTO ASSUMIDO",
    "",
    `Cliente: ${campo(resumo.nome)}`,
    `Telefone: ${campo(resumo.telefone)}`,
    ...linhasDeItens(resumo.produto, resumo.quantidade, campo),
    `Observações: ${campo(resumo.observacoes)}`,
  ];

  if (!link) {
    linhas.push("", "Telefone indisponível para abrir o WhatsApp diretamente.");
  }

  return cortarTexto(linhas.join("\n"), LIMITE_TEXTO_TELEGRAM);
}

/**
 * Vendedor registrado escreveu ao bot (/start, ASSUMIR, comandos...):
 * se o nome dele no Telegram mudou, atualiza a memória e o banco (falha
 * de banco: regravado depois). O log não leva o nome.
 */
async function atualizarNomeVendedor(usuario: TelegramUsuario | undefined): Promise<void> {
  if (!usuario || usuario.is_bot) {
    return;
  }

  const userId = normalizarIdTelegram(usuario.id);

  const vendedor = userId ? vendedores.get(userId) : undefined;

  if (!vendedor) {
    return;
  }

  const nome = nomeDoUsuario(usuario);

  if (nome === vendedor.nome) {
    return;
  }

  vendedor.nome = nome;

  const dados: DadosVendedor = { telegramUserId: userId, nome, chatPrivadoId: vendedor.chatPrivadoId };

  anotarGravacao({ tipo: "vendedor", dados }, await registrarVendedor(dados));

  console.log(`[Telegram] nome do vendedor ${mascararIdTelegram(userId)} atualizado.`);
}

function nomeDoUsuario(usuario: TelegramUsuario): string {
  const nome = [usuario.first_name, usuario.last_name]
    .filter((parte) => typeof parte === "string" && parte.trim() !== "")
    .join(" ")
    .trim();

  if (nome) {
    return nome.slice(0, 64);
  }

  if (usuario.username) {
    return `@${usuario.username}`.slice(0, 64);
  }

  return "Vendedor";
}

/**
 * Evita processar o mesmo update/callback duas vezes.
 */
function jaProcessado(chave: string): boolean {
  if (idsProcessados.has(chave)) {
    return true;
  }

  idsProcessados.add(chave);

  if (idsProcessados.size > MAX_IDS_PROCESSADOS) {
    const primeiro = idsProcessados.values().next().value;

    if (primeiro !== undefined) {
      idsProcessados.delete(primeiro);
    }
  }

  return false;
}

function limparAtendimentosAntigos(agora = Date.now()): void {
  for (const [id, atd] of atendimentos) {
    if (agora - atd.criadoEm >= RETENCAO_ATENDIMENTO_MS) {
      atendimentos.delete(id);
    }
  }

  while (atendimentos.size > MAX_ATENDIMENTOS) {
    const maisAntigo = atendimentos.keys().next().value;

    if (maisAntigo === undefined) {
      break;
    }

    atendimentos.delete(maisAntigo);
  }
}

/**
 * Envia o resumo ao grupo com o botão ASSUMIR.
 *
 * Idempotente por atendimento: só reenvia
 * se o envio anterior falhou.
 */
export async function enviarResumoTelegram(
  atendimentoId: string,
  chatIdCliente: string,
  resumo: ResumoCliente,
  opcoes: { avisoFalhaEnvio?: boolean; etapaParada?: string } = {},
): Promise<boolean> {
  if (!telegramConfigurado()) {
    console.error(
      `[Telegram] resumo de ${atendimentoId} não enviado: TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID ausente.`,
    );

    return false;
  }

  const existente = atendimentos.get(atendimentoId);

  if (existente && opcoes.avisoFalhaEnvio) {
    existente.avisoFalhaEnvio = true;
  }

  if (existente && existente.envioResumo !== "falhou") {
    /* "recusado" também cai aqui: não repete um pedido que o Telegram recusou. */
    console.log(
      `[Telegram] resumo de ${atendimentoId} já ${existente.envioResumo}; ignorado.`,
    );

    return existente.envioResumo === "enviado";
  }

  limparAtendimentosAntigos();

  const atd: AtendimentoTelegram = existente ?? {
    atendimentoId,
    chatIdCliente,
    resumo: { ...resumo },
    envioResumo: "enviando",
    avisoFalhaEnvio: opcoes.avisoFalhaEnvio === true,
    etapaParada: opcoes.etapaParada ?? null,
    publicadoEm: null,
    lembreteSemAssumir: false,
    mensagemGrupoId: null,
    vendedorId: null,
    vendedorNome: null,
    dm: "pendente",
    criadoEm: Date.now(),
    avisoClienteFeito: false,
    lembreteMensagemId: null,
    repassesGrupo: [],
    assumidoEm: null,
    resumoApagado: false,
  };

  atd.envioResumo = "enviando";

  atendimentos.set(atendimentoId, atd);

  /*
   * Registrado no lock ANTES do envio: um clique
   * logo após a mensagem chegar já encontra o ATD.
   */
  lock.registrarPendente(atendimentoId, chatIdCliente);

  const resposta = await chamarTelegram<TelegramMensagem>("sendMessage", {
    chat_id: config().chatId,

    text: formatarResumoGrupo(atd.resumo, atd.avisoFalhaEnvio, atd.etapaParada),

    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🔒 ASSUMIR ATENDIMENTO",
            callback_data: `assumir:${atendimentoId}`,
          },
        ],
      ],
    },
  });

  if (resposta.ok && resposta.result) {
    atd.envioResumo = "enviado";

    atd.mensagemGrupoId = resposta.result.message_id;

    atd.publicadoEm = Date.now();

    console.log(`[Telegram] resumo de ${atendimentoId} enviado ao grupo.`);

    /*
     * Espelho: a mensagem que está valendo (falha de banco: regravada depois).
     */
    const resumoPublicado: PendenciaBanco = {
      tipo: "resumo",
      codigo: atendimentoId,
      telegramChatId: resposta.result.chat?.id ?? config().chatId,
      telegramMessageId: resposta.result.message_id,
      publicadoEm: new Date(),
    };

    anotarGravacao(
      resumoPublicado,
      (await registrarResumoPublicado(atendimentoId, resumoPublicado.telegramChatId, resumoPublicado.telegramMessageId)) !== "erro",
    );

    return true;
  }

  if (erroPermanente(resposta)) {
    atd.envioResumo = "recusado";

    console.error(
      `[Telegram] ATENÇÃO: resumo de ${atendimentoId} RECUSADO pelo Telegram (código ${resposta.error_code}); não será reenviado. Verifique o bot e o grupo.`,
    );

    if (grupoInacessivel(resposta)) {
      alertarGrupoInacessivel();
    }

    return false;
  }

  atd.envioResumo = "falhou";

  console.error(
    `[Telegram] resumo de ${atendimentoId} não enviado; nova tentativa no próximo ciclo.`,
  );

  return false;
}

/**
 * Bot sem acesso ao grupo: avisa os administradores no privado (no
 * máximo 1 a cada 30 min). Não espera o envio (a fila da conversa
 * segue).
 */
function alertarGrupoInacessivel(): void {
  const agora = Date.now();

  if (ultimoAlertaGrupoEm !== null && agora - ultimoAlertaGrupoEm < INTERVALO_ALERTA_GRUPO_MS) {
    console.error("[Alerta] grupo de vendedores inacessível; alerta já enviado há menos de 30 min.");

    return;
  }

  ultimoAlertaGrupoEm = agora;

  console.error("[Alerta] ATENÇÃO: grupo de vendedores inacessível (403); avisando os administradores.");

  filaAlertaGrupo = filaAlertaGrupo
    .then(async () => {
      await avisarAdministradores(MENSAGEM_GRUPO_INACESSIVEL);
    })
    .catch((erro: unknown) => {
      console.error(`[Alerta] falha ao avisar os administradores (${descreverErro(erro)}).`);
    });
}

/**
 * Somente para testes: espera o alerta de grupo inacessível.
 */
export function aguardarAlertaGrupoParaTestes(): Promise<void> {
  return filaAlertaGrupo;
}

/**
 * Situação do resumo de um atendimento no grupo.
 */
export function situacaoResumoTelegram(
  atendimentoId: string,
): "nenhum" | "enviando" | "enviado" | "falhou" | "recusado" {
  return atendimentos.get(atendimentoId)?.envioResumo ?? "nenhum";
}

/**
 * Manda um texto no PRIVADO de cada administrador/criador do grupo
 * de vendedores (getChatAdministrators, sem bots) que esteja
 * registrado (/start). Nunca manda para o grupo.
 *
 * Devolve quantos receberam. Telegram fora ou nenhum administrador
 * alcançável: só log.
 */
export async function avisarAdministradores(texto: string): Promise<number> {
  if (!telegramConfigurado()) {
    console.error("[Alerta] ATENÇÃO: Telegram não configurado; alerta aos administradores não enviado.");

    return 0;
  }

  const resposta = await chamarTelegram<{ status?: unknown; user?: TelegramUsuario }[]>(
    "getChatAdministrators",
    { chat_id: config().chatId },
    TIMEOUT_GET_CHAT_MEMBER_MS,
  );

  let administradores: string[];

  if (resposta.ok && Array.isArray(resposta.result)) {
    administradores = resposta.result
      .filter(
        (membro) =>
          (membro.status === "administrator" || membro.status === "creator") &&
          membro.user !== undefined &&
          membro.user.is_bot !== true,
      )
      .map((membro) => normalizarIdTelegram(membro.user?.id))
      .filter((id) => id !== "");

    administradoresConhecidos = new Set(administradores);
  } else if (administradoresConhecidos.size > 0) {
    /*
     * Grupo inacessível (ex.: bot removido): os vistos por último.
     */
    administradores = [...administradoresConhecidos];

    console.error(`[Alerta] administradores do grupo não consultados; usando os ${administradores.length} vistos por último.`);
  } else {
    console.error("[Alerta] ATENÇÃO: administradores do grupo não consultados; alerta não enviado.");

    return 0;
  }

  let enviados = 0;

  for (const adminId of administradores) {
    const vendedor = vendedores.get(adminId);

    if (!vendedor) {
      continue;
    }

    const envio = await chamarTelegram("sendMessage", { chat_id: vendedor.chatPrivadoId, text: texto });

    if (envio.ok) {
      enviados++;
    }
  }

  if (enviados === 0) {
    console.error(
      `[Alerta] ATENÇÃO: nenhum administrador alcançável (${administradores.length} administrador(es) no grupo; nenhum registrado pelo /start ou a DM falhou).`,
    );
  } else {
    console.log(`[Alerta] enviado a ${enviados} de ${administradores.length} administrador(es).`);
  }

  return enviados;
}

/*
 * Resumo publicado e ninguém assumiu depois deste tempo: um lembrete no
 * grupo (resposta ao resumo), uma vez por resumo.
 */
export const LEMBRETE_SEM_ASSUMIR_MS = 20 * 60 * 1000;

let verificandoLembretes = false;

function tempoEmTexto(ms: number): string {
  const minutos = Math.floor(ms / 60_000);

  if (minutos < 60) {
    return `${minutos} min`;
  }

  const resto = minutos % 60;

  return resto === 0 ? `${Math.floor(minutos / 60)} h` : `${Math.floor(minutos / 60)} h ${resto} min`;
}

/**
 * Chamada a cada 30 s: resumo publicado há LEMBRETE_SEM_ASSUMIR_MS sem
 * ninguém assumir recebe UM lembrete no grupo (com a loja aberta). A
 * marca no banco é reservada antes do envio (reinício não repete);
 * banco fora: vale a memória. Devolve quantos lembretes saíram.
 */
export async function verificarLembretesSemAssumir(agora = Date.now()): Promise<number> {
  if (!telegramConfigurado() || verificandoLembretes || !lojaAberta(agora)) {
    return 0;
  }

  verificandoLembretes = true;

  let enviados = 0;

  try {
    for (const atd of [...atendimentos.values()]) {
      if (
        atd.envioResumo !== "enviado" ||
        atd.vendedorId !== null ||
        atd.lembreteSemAssumir ||
        atd.mensagemGrupoId === null ||
        atd.publicadoEm === null ||
        agora - atd.publicadoEm < LEMBRETE_SEM_ASSUMIR_MS
      ) {
        continue;
      }

      atd.lembreteSemAssumir = true;

      const reserva = await reservarLembreteSemAssumir(atd.atendimentoId);

      if (reserva === "nao_enviar" || atd.vendedorId !== null) {
        continue;
      }

      const nome = primeiroNomeVendedor(nomeDoCliente(atd.resumo.nome));

      const tempo = tempoEmTexto(agora - atd.publicadoEm);

      const resposta = await chamarTelegram<TelegramMensagem>("sendMessage", {
        chat_id: config().chatId,
        text: nome ? `⚠️ Atendimento de ${nome} sem assumir há ${tempo}` : `⚠️ Atendimento sem assumir há ${tempo}`,
        reply_parameters: { message_id: atd.mensagemGrupoId, allow_sending_without_reply: true },
      });

      if (resposta.ok) {
        enviados++;

        if (resposta.result) {
          atd.lembreteMensagemId = resposta.result.message_id;

          await gravarLembreteMensagem(atd.atendimentoId, atd.lembreteMensagemId);

          /* Assumido enquanto o lembrete saía: apaga já. */
          if (atd.vendedorId !== null) {
            await apagarLembrete(atd);
          }
        }

        console.log(`[Telegram] lembrete de ${atd.atendimentoId} (sem assumir) publicado no grupo.`);
      } else {
        console.error(`[Telegram] lembrete de ${atd.atendimentoId} (sem assumir) não publicado (código ${resposta.error_code ?? "rede"}).`);
      }
    }
  } finally {
    verificandoLembretes = false;
  }

  return enviados;
}

/**
 * Mensagem do cliente depois do encaminhamento: vai ao vendedor que
 * assumiu (privado do bot) ou, sem ninguém (ou com o privado falhando),
 * ao grupo, como resposta ao resumo. Nunca no log.
 */
export async function repassarMensagemAoVendedor(
  atendimentoId: string,
  chatIdCliente: string,
  resumo: ResumoCliente,
  texto: string,
): Promise<"privado" | "grupo" | "falhou"> {
  if (!telegramConfigurado()) {
    return "falhou";
  }

  const atd = atendimentos.get(atendimentoId);

  const quem = nomeDoCliente(atd?.resumo.nome ?? resumo.nome) ?? telefoneParaGrupo(resumo.telefone || (chatIdCliente.split(":").at(-1) ?? ""));

  const mensagem = `📩 ${quem} escreveu: "${cortarTexto(texto, LIMITE_CAMPO)}"`;

  const vendedor = atd?.vendedorId ? vendedores.get(atd.vendedorId) : undefined;

  if (vendedor) {
    const privado = await chamarTelegram("sendMessage", { chat_id: vendedor.chatPrivadoId, text: mensagem });

    if (privado.ok) {
      return "privado";
    }

    console.error(`[Telegram] mensagem do cliente de ${atendimentoId} não chegou ao privado do vendedor; vai ao grupo.`);
  }

  const grupo = await chamarTelegram<TelegramMensagem>("sendMessage", {
    chat_id: config().chatId,
    text: mensagem,
    ...(atd?.mensagemGrupoId ? { reply_parameters: { message_id: atd.mensagemGrupoId, allow_sending_without_reply: true } } : {}),
  });

  if (grupo.ok) {
    /*
     * Ninguém assumiu: quem assumir recebe estas no privado e elas saem
     * do grupo.
     */
    if (atd && atd.vendedorId === null && grupo.result) {
      const repasse: RepasseGrupo = { id: grupo.result.message_id, texto, em: Date.now() };

      atd.repassesGrupo.push(repasse);

      await anexarRepasseGrupo(atendimentoId, repasse);
    }

    return "grupo";
  }

  console.error(`[Telegram] mensagem do cliente de ${atendimentoId} não repassada (código ${grupo.error_code ?? "rede"}).`);

  return "falhou";
}

/*
 * Faxina do grupo: o Telegram só deixa o bot apagar mensagens com menos
 * de 48 h (margem de 10 min). O resumo assumido sai do grupo depois de
 * APAGAR_RESUMO_ASSUMIDO_MS (o banco continua com tudo).
 */
const LIMITE_APAGAR_MS = 48 * 60 * 60 * 1000 - 10 * 60 * 1000;

export const APAGAR_RESUMO_ASSUMIDO_MS = 30 * 60 * 1000;

/**
 * Apaga uma mensagem do bot no grupo. Falha (ou mais de 48 h): só aviso
 * no log. Devolve se apagou.
 */
async function apagarDoGrupo(messageId: number, enviadaEm: number | null, rotulo: string): Promise<boolean> {
  if (enviadaEm !== null && Date.now() - enviadaEm > LIMITE_APAGAR_MS) {
    console.warn(`[Telegram] aviso: ${rotulo} não apagado do grupo (mais de 48 h).`);

    return false;
  }

  const resposta = await chamarTelegram("deleteMessage", { chat_id: config().chatId, message_id: messageId });

  if (!resposta.ok) {
    console.warn(`[Telegram] aviso: ${rotulo} não apagado do grupo (código ${resposta.error_code ?? "rede"}).`);

    return false;
  }

  return true;
}

async function apagarLembrete(atd: AtendimentoTelegram): Promise<void> {
  const id = atd.lembreteMensagemId;

  if (id === null) {
    return;
  }

  atd.lembreteMensagemId = null;

  await apagarDoGrupo(id, null, `lembrete de ${atd.atendimentoId}`);

  await gravarLembreteMensagem(atd.atendimentoId, null);
}

/**
 * Alguém assumiu: o lembrete sai do grupo; as mensagens do cliente
 * repassadas ao grupo antes disso vão para o privado de quem assumiu
 * (em ordem, numa mensagem só) e, entregues, saem do grupo.
 */
async function faxinaAoAssumir(atd: AtendimentoTelegram, vendedor: Vendedor): Promise<void> {
  await apagarLembrete(atd);

  const repasses = [...atd.repassesGrupo];

  if (repasses.length === 0) {
    return;
  }

  const quem = nomeDoCliente(atd.resumo.nome) ?? telefoneParaGrupo(atd.resumo.telefone);

  const texto = cortarTexto(
    [`📩 Antes de você assumir, ${quem} escreveu:`, ...repasses.map((r) => `"${cortarTexto(r.texto, LIMITE_CAMPO)}"`)].join("\n"),
    LIMITE_TEXTO_TELEGRAM,
  );

  const privado = await chamarTelegram("sendMessage", { chat_id: vendedor.chatPrivadoId, text: texto });

  if (!privado.ok) {
    console.warn(`[Telegram] aviso: mensagens anteriores de ${atd.atendimentoId} não chegaram ao privado; ficam no grupo.`);

    return;
  }

  atd.repassesGrupo = [];

  await limparRepassesGrupo(atd.atendimentoId);

  for (const r of repasses) {
    await apagarDoGrupo(r.id, r.em, `repasse de ${atd.atendimentoId}`);
  }

  console.log(`[Telegram] ${repasses.length} mensagem(ns) anterior(es) de ${atd.atendimentoId} levada(s) ao privado de quem assumiu.`);
}

/**
 * Chamada a cada 60 s: resumo assumido há APAGAR_RESUMO_ASSUMIDO_MS sai
 * do grupo (uma vez; o banco guarda que saiu). Devolve quantos apagou.
 */
export async function apagarResumosAssumidos(agora = Date.now()): Promise<number> {
  if (!telegramConfigurado()) {
    return 0;
  }

  let apagados = 0;

  for (const atd of [...atendimentos.values()]) {
    if (
      atd.resumoApagado ||
      atd.vendedorId === null ||
      atd.assumidoEm === null ||
      atd.mensagemGrupoId === null ||
      agora - atd.assumidoEm < APAGAR_RESUMO_ASSUMIDO_MS
    ) {
      continue;
    }

    atd.resumoApagado = true;

    if (await apagarDoGrupo(atd.mensagemGrupoId, atd.publicadoEm, `resumo assumido de ${atd.atendimentoId}`)) {
      apagados++;

      console.log(`[Telegram] resumo assumido de ${atd.atendimentoId} apagado do grupo.`);
    }

    await marcarResumoApagado(atd.atendimentoId);
  }

  return apagados;
}

/**
 * Reenvia resumos cujo envio falhou.
 */
export async function reenviarResumosTelegramPendentes(): Promise<void> {
  limparAtendimentosAntigos();

  for (const atd of [...atendimentos.values()]) {
    if (atd.envioResumo === "falhou") {
      await enviarResumoTelegram(atd.atendimentoId, atd.chatIdCliente, atd.resumo);
    }
  }
}

/**
 * Valida o header X-Telegram-Bot-Api-Secret-Token.
 *
 * Sem TELEGRAM_WEBHOOK_SECRET configurado,
 * nada é aceito (falha fechada).
 */
export function segredoWebhookTelegramValido(header: unknown): boolean {
  const { segredo } = config();

  if (!segredo) {
    console.error("[Telegram] TELEGRAM_WEBHOOK_SECRET não configurado; update recusado.");

    return false;
  }

  if (typeof header !== "string" || header === "") {
    return false;
  }

  const a = createHash("sha256").update(header, "utf8").digest();

  const b = createHash("sha256").update(segredo, "utf8").digest();

  return timingSafeEqual(a, b);
}

async function responderCallback(
  callbackId: string,
  texto: string,
  alerta = false,
): Promise<void> {
  await chamarTelegram("answerCallbackQuery", {
    callback_query_id: callbackId,
    text: texto,
    show_alert: alerta,
  });
}

/**
 * Edita a mensagem do grupo para "assumido".
 * Sem reply_markup: o botão ASSUMIR some.
 */
async function atualizarMensagemGrupo(atd: AtendimentoTelegram): Promise<void> {
  if (atd.mensagemGrupoId === null) {
    return;
  }

  const resposta = await chamarTelegram("editMessageText", {
    chat_id: config().chatId,
    message_id: atd.mensagemGrupoId,
    text: formatarAssumidoGrupo(atd),
  });

  if (!resposta.ok) {
    console.error(
      `[Telegram] mensagem do grupo de ${atd.atendimentoId} não editada.`,
    );
  }
}

/**
 * Avisa o CLIENTE (pelo número da loja) que o vendedor assumiu. Uma vez
 * por atendimento: a memória segura cliques e chamadas deste processo, e
 * o banco (aviso_assuncao_em, reservado ANTES do envio) segura reinícios.
 * Banco fora: envia (memória) e a marca fica pendente para regravar.
 * Falha no envio não desfaz a assunção: só log (e o alerta geral de
 * envio, pelo webhook).
 */
async function avisarClienteDaAssuncao(atd: AtendimentoTelegram): Promise<void> {
  const enviar = enviarAoClienteGancho;

  if (atd.avisoClienteFeito || !enviar || atd.vendedorId === null) {
    return;
  }

  atd.avisoClienteFeito = true;

  const reserva = await reservarAvisoAssuncao(atd.atendimentoId);

  if (reserva === "ja_enviado") {
    console.log(`[Telegram] aviso de assunção de ${atd.atendimentoId} já enviado antes; não repetido.`);

    return;
  }

  if (reserva === "erro") {
    anotarGravacao({ tipo: "aviso", codigo: atd.atendimentoId, em: new Date() }, false);
  }

  const nomeVendedor = vendedores.get(atd.vendedorId)?.nome ?? atd.vendedorNome;

  const resultado = await enviar(atd.chatIdCliente, textoAvisoAssuncao(atd.resumo.nome, nomeVendedor, lojaAberta()));

  if (resultado === "falhou") {
    console.error(`[Telegram] aviso de assunção de ${atd.atendimentoId} NÃO entregue ao cliente; a assunção continua valendo.`);
  } else {
    console.log(`[Telegram] aviso de assunção de ${atd.atendimentoId} ${resultado === "enviado" ? "enviado ao cliente" : "não enviado (META_ENVIO_ATIVO=false)"}.`);
  }
}

/**
 * Envia a DM com os dados do cliente ao vencedor.
 *
 * ÚNICO lugar que monta o botão wa.me.
 */
async function enviarDMVencedor(
  atd: AtendimentoTelegram,
  vendedor: Vendedor,
): Promise<boolean> {
  if (atd.vendedorId !== vendedor.userId) {
    console.error(
      `[Telegram] DM de ${atd.atendimentoId} bloqueada: destinatário não é o vencedor.`,
    );

    return false;
  }

  atd.dm = "enviando";

  /*
   * O link abre o WhatsApp com a mensagem pronta (nunca vai para o log).
   */
  const link = gerarLinkWhatsApp(atd.resumo.telefone, textoMensagemWaMe(atd.resumo, vendedor.nome));

  const corpo: Record<string, unknown> = {
    chat_id: vendedor.chatPrivadoId,
    text: formatarDM(atd.resumo, link),
  };

  if (link) {
    corpo.reply_markup = {
      inline_keyboard: [[{ text: "💬 ABRIR WHATSAPP", url: link }]],
    };
  }

  const resposta = await chamarTelegram("sendMessage", corpo);

  atd.dm = resposta.ok ? "enviada" : "falhou";

  /*
   * Espelho do resultado da DM (falha de banco: regravado depois).
   */
  const statusDm = resposta.ok ? "ENVIADA" : "FALHOU";

  anotarGravacao(
    { tipo: "dm", codigo: atd.atendimentoId, status: statusDm },
    await registrarDmStatus(atd.atendimentoId, statusDm),
  );

  if (resposta.ok) {
    console.log(
      `[Telegram] DM de ${atd.atendimentoId} enviada ao vendedor (cliente ${mascararTelefone(atd.resumo.telefone.replace(/\D/g, ""))}).`,
    );
  } else {
    console.error(
      `[Telegram] DM de ${atd.atendimentoId} NÃO enviada. Lock mantido; o vendedor recebe de novo ao enviar /start no privado.`,
    );
  }

  return resposta.ok;
}

type ParticipacaoGrupo = "autorizado" | "fora_da_equipe" | "erro";

/**
 * Status do usuário no grupo dos vendedores (getChatMember,
 * sem cache, com timeout). null = falha técnica.
 */
async function statusNoGrupo(usuarioId: number): Promise<string | null> {
  const resposta = await chamarTelegram<{ status?: unknown }>(
    "getChatMember",
    { chat_id: config().chatId, user_id: usuarioId },
    TIMEOUT_GET_CHAT_MEMBER_MS,
  );

  const status = resposta.ok ? resposta.result?.status : undefined;

  if (typeof status !== "string" || status === "") {
    return null;
  }

  const id = normalizarIdTelegram(usuarioId);

  if (id && STATUS_ADMINISTRADORES.has(status)) {
    administradoresConhecidos.add(id);
  } else if (id) {
    administradoresConhecidos.delete(id);
  }

  return status;
}

/**
 * O usuário faz parte AGORA do grupo dos vendedores?
 *
 * Consulta getChatMember a cada chamada (sem cache): sair ou
 * ser removido do grupo retira a autorização na hora.
 * O bot precisa ser administrador do grupo.
 *
 * - "autorizado": member, administrator ou creator;
 * - "fora_da_equipe": qualquer outro status (left, kicked,
 *   restricted...);
 * - "erro": falha técnica (HTTP/API, rede, timeout, resposta
 *   inesperada). Também NEGA o acesso.
 */
async function participaDoGrupoVendedores(usuarioId: number): Promise<ParticipacaoGrupo> {
  const status = await statusNoGrupo(usuarioId);

  if (status === null) {
    console.log(
      `[Telegram] participação no grupo não verificada (user_id ${mascararIdTelegram(usuarioId)}): falha técnica; acesso negado.`,
    );

    return "erro";
  }

  if (STATUS_AUTORIZADOS.has(status)) {
    console.log(
      `[Telegram] participação no grupo confirmada (user_id ${mascararIdTelegram(usuarioId)}, status: ${status}).`,
    );

    return "autorizado";
  }

  console.log(
    `[Telegram] user_id ${mascararIdTelegram(usuarioId)} fora da equipe de vendedores (status no grupo: ${status}); acesso negado.`,
  );

  return "fora_da_equipe";
}

async function processarStartPrivado(mensagem: TelegramMensagem): Promise<void> {
  const usuario = mensagem.from;

  if (!usuario || usuario.is_bot) {
    return;
  }

  const userId = normalizarIdTelegram(usuario.id);

  if (!userId) {
    return;
  }

  /*
   * Só quem está no grupo dos vendedores é registrado.
   */
  const participacao = await participaDoGrupoVendedores(usuario.id);

  if (participacao !== "autorizado") {
    /*
     * Fora do grupo: o registro anterior deixa de valer.
     * Falha técnica: nada muda (não dá para saber).
     */
    if (participacao === "fora_da_equipe") {
      vendedores.delete(userId);
    }

    await chamarTelegram("sendMessage", {
      chat_id: mensagem.chat.id,
      text:
        participacao === "erro"
          ? MENSAGEM_VERIFICACAO_FALHOU
          : MENSAGEM_FORA_DA_EQUIPE,
    });

    return;
  }

  const vendedor: Vendedor = {
    userId,
    nome: nomeDoUsuario(usuario),
    chatPrivadoId: mensagem.chat.id,
  };

  vendedores.set(userId, vendedor);

  console.log(`[Telegram] vendedor registrado pelo /start (user_id ${mascararIdTelegram(userId)}).`);

  /*
   * Também no banco: depois de um reinício o vendedor volta sem
   * novo /start. Falha de banco: a memória vale e o banco é
   * regravado depois.
   */
  const dadosVendedor: DadosVendedor = {
    telegramUserId: userId,
    nome: vendedor.nome,
    chatPrivadoId: vendedor.chatPrivadoId,
  };

  anotarGravacao({ tipo: "vendedor", dados: dadosVendedor }, await registrarVendedor(dadosVendedor));

  await chamarTelegram("sendMessage", {
    chat_id: vendedor.chatPrivadoId,
    text: "✅ Você está registrado para assumir atendimentos da loja Exemplo Materiais de Construção. Envie /ajuda para ver os comandos.",
  });

  /*
   * Administrador do grupo (visto no getChatMember acima): menu completo
   * no chat privado dele.
   */
  if (administradoresConhecidos.has(userId)) {
    await definirMenuDoChat(vendedor.chatPrivadoId, true);
  }

  /*
   * Reenvio seguro: só as DMs que falharam
   * e cujo vencedor é ESTE vendedor.
   */
  for (const atd of atendimentos.values()) {
    if (atd.vendedorId === userId && atd.dm === "falhou") {
      const ok = await enviarDMVencedor(atd, vendedor);

      if (ok) {
        await atualizarMensagemGrupo(atd);
      }
    }
  }
}

async function processarCallback(callback: TelegramCallbackQuery): Promise<void> {
  if (jaProcessado(`cb:${callback.id}`)) {
    return;
  }

  const mensagem = callback.message;

  /*
   * Só cliques no grupo configurado.
   */
  if (!mensagem || String(mensagem.chat.id) !== config().chatId) {
    console.log("[Telegram] callback fora do grupo configurado; ignorado.");

    await responderCallback(callback.id, MENSAGEM_INDISPONIVEL);

    return;
  }

  const correspondencia = CALLBACK_ASSUMIR.exec(callback.data ?? "");

  const atendimentoId = correspondencia?.[1];

  const atd = atendimentoId ? atendimentos.get(atendimentoId) : undefined;

  /*
   * O clique precisa ser na MESMA mensagem que o
   * bot enviou para esse atendimento.
   */
  if (!atendimentoId || !atd || atd.mensagemGrupoId !== mensagem.message_id) {
    await responderCallback(callback.id, MENSAGEM_INDISPONIVEL);

    return;
  }

  const userId = normalizarIdTelegram(callback.from.id);

  /*
   * Autorização ANTES de qualquer lock, mesmo para quem
   * já fez /start: precisa estar no grupo agora.
   */
  if (!userId) {
    await responderCallback(callback.id, MENSAGEM_FORA_DA_EQUIPE, true);

    return;
  }

  const participacao = await participaDoGrupoVendedores(callback.from.id);

  if (participacao !== "autorizado") {
    await responderCallback(
      callback.id,
      participacao === "erro" ? MENSAGEM_VERIFICACAO_FALHOU : MENSAGEM_FORA_DA_EQUIPE,
      true,
    );

    return;
  }

  const vendedor = vendedores.get(userId);

  /*
   * No grupo, mas sem /start no privado (não há chat
   * para a DM): não tenta o lock.
   */
  if (!vendedor) {
    await responderCallback(callback.id, MENSAGEM_ONBOARDING, true);

    return;
  }

  /*
   * Lock síncrono: nenhum await entre a decisão
   * e a gravação do vencedor abaixo.
   */
  const tentativa = lock.tentarAssumir(atendimentoId, userId);

  switch (tentativa.resultado) {
    case ResultadoAssumir.ASSUMIDO: {
      atd.vendedorId = userId;

      atd.vendedorNome = vendedor.nome;

      atd.dm = "enviando";

      /*
       * Segundo portão: o banco (UPDATE só se ainda sem vendedor).
       * Linha inexistente ou falha de banco NÃO impedem a
       * assunção: segue pela memória, como antes.
       */
      const dadosAssuncao: DadosAssuncao = {
        codigo: atendimentoId,
        telegramUserId: userId,

        /*
         * Nome ATUAL no Telegram (do clique), não o do /start.
         */
        nome: nomeDoUsuario(callback.from),
        chatPrivadoId: vendedor.chatPrivadoId,
        telegramChatId: mensagem.chat.id,
        telegramMessageId: mensagem.message_id,
      };

      const assumidoEm = new Date(Date.now());

      atd.assumidoEm = assumidoEm.getTime();

      const banco = await registrarAssuncao(dadosAssuncao);

      /*
       * Falha de banco: regravada depois, com o horário real.
       */
      anotarGravacao({ tipo: "assuncao", dados: { ...dadosAssuncao, assumidoEm } }, banco !== "erro");

      if (banco === "ja_por_outro") {
        /*
         * O banco vence (proteção para depois de um reinício):
         * a memória NÃO fica com este vendedor.
         */
        lock.desfazerAssuncao(atendimentoId, userId);

        atd.assumidoEm = null;

        atd.vendedorId = null;

        atd.vendedorNome = null;

        atd.dm = "pendente";

        console.error(
          `[Telegram] ${atendimentoId}: o banco já registra outro vendedor; assunção recusada.`,
        );

        await responderCallback(
          callback.id,
          "Este atendimento já foi assumido por outro vendedor.",
          true,
        );

        return;
      }

      if (banco === "sem_linha" || banco === "erro") {
        console.warn(
          `[Telegram] ${atendimentoId}: assunção não gravada no banco (${banco === "erro" ? "falha de banco; nova tentativa a cada minuto" : "atendimento ausente"}); segue pela memória.`,
        );
      }

      try {
        aoAssumir(atendimentoId);
      } catch (erro: unknown) {
        console.error(
          `[Telegram] falha ao marcar ${atendimentoId} como HUMANO:`,
          descreverErro(erro),
        );
      }

      /*
       * O banco já tinha ESTE vendedor (depois de um reinício):
       * mesma resposta de hoje para "já assumido por você".
       */
      if (banco === "ja_por_voce" || banco === "ja_por_voce_dm_pendente") {
        await responderCallback(callback.id, "Você já assumiu este atendimento.");

        /*
         * A DM não consta como ENVIADA no banco (ENVIANDO ou
         * FALHOU): reenvia. Duplicar é aceitável; perder não.
         */
        if (banco === "ja_por_voce_dm_pendente") {
          const ok = await enviarDMVencedor(atd, vendedor);

          if (ok) {
            await atualizarMensagemGrupo(atd);
          }
        } else {
          atd.dm = "enviada";
        }

        /*
         * Depois de um reinício: o aviso só sai se ainda não saiu (banco).
         */
        await avisarClienteDaAssuncao(atd);

        await faxinaAoAssumir(atd, vendedor);

        return;
      }

      await responderCallback(
        callback.id,
        "Atendimento assumido! Os dados do cliente foram enviados no seu privado.",
      );

      const dmOk = await enviarDMVencedor(atd, vendedor);

      /*
       * Remove o botão e informa quem assumiu
       * (e o erro da DM, se houve).
       */
      await atualizarMensagemGrupo(atd);

      if (!dmOk) {
        console.error(
          `[Telegram] ${atendimentoId} assumido, mas a DM falhou. Atendimento continua HUMANO.`,
        );
      }

      /*
       * Assunção confirmada: o cliente fica sabendo (uma vez só).
       */
      await avisarClienteDaAssuncao(atd);

      /*
       * Faxina do grupo: lembrete apagado; mensagens anteriores do cliente
       * para o privado de quem assumiu.
       */
      await faxinaAoAssumir(atd, vendedor);

      return;
    }

    case ResultadoAssumir.JA_ASSUMIDO_POR_VOCE: {
      await responderCallback(callback.id, "Você já assumiu este atendimento.");

      if (atd.dm === "falhou") {
        const ok = await enviarDMVencedor(atd, vendedor);

        if (ok) {
          await atualizarMensagemGrupo(atd);
        }
      }

      await avisarClienteDaAssuncao(atd);

      return;
    }

    case ResultadoAssumir.JA_ASSUMIDO_POR_OUTRO: {
      const quem = atd.vendedorNome ? ` (${atd.vendedorNome})` : "";

      await responderCallback(
        callback.id,
        `Este atendimento já foi assumido por outro vendedor${quem}.`,
        true,
      );

      return;
    }

    case ResultadoAssumir.VENDEDOR_NAO_AUTORIZADO: {
      await responderCallback(callback.id, MENSAGEM_ONBOARDING, true);

      return;
    }

    default: {
      await responderCallback(callback.id, MENSAGEM_INDISPONIVEL);
    }
  }
}

/**
 * /ranking no privado: só administradores do grupo.
 * Só nomes de vendedores e números (sem cliente, sem codigo).
 */
/**
 * Só administrador/criador do grupo de vendedores (getChatMember, sem
 * cache). Responde a negação ou o erro técnico e devolve false.
 */
async function verificarAdministrador(
  usuario: TelegramUsuario,
  responder: (texto: string) => Promise<unknown>,
  comando: string,
): Promise<boolean> {
  const status = await statusNoGrupo(usuario.id);

  if (status === null) {
    await responder(MENSAGEM_VERIFICACAO_FALHOU);

    return false;
  }

  if (!STATUS_ADMINISTRADORES.has(status)) {
    console.log(`[Telegram] ${comando} negado (user_id ${mascararIdTelegram(usuario.id)}, status: ${status}).`);

    await responder(MENSAGEM_SO_ADMIN);

    return false;
  }

  return true;
}

const DIAS_DA_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

const doisDigitos = (n: number) => String(n).padStart(2, "0");

/**
 * "AAAA-MM-DD" → "sexta, 25/12" (com "/AAAA" se não for o ano atual).
 */
function descreverDia(data: string, anoAtual: string): string {
  const [ano = "", mes = "", dia = ""] = data.split("-");

  const semana = DIAS_DA_SEMANA[new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia))).getUTCDay()];

  return `${semana}, ${dia}/${mes}${ano === anoAtual ? "" : `/${ano}`}`;
}

/**
 * Argumento do /fechar e do /abrir → "AAAA-MM-DD".
 *
 * Vazio = hoje. "DD/MM" = essa data no ano atual; se já passou neste
 * ano, no próximo. Data inexistente (31/02, 00/13) ou texto: null.
 */
function interpretarDia(argumento: string, hoje: string): string | null {
  if (argumento === "") {
    return hoje;
  }

  const partes = /^(\d{1,2})\/(\d{1,2})$/.exec(argumento);

  if (!partes) {
    return null;
  }

  const dia = Number(partes[1]);

  const mes = Number(partes[2]);

  const anoHoje = Number(hoje.slice(0, 4));

  for (const ano of [anoHoje, anoHoje + 1]) {
    const d = new Date(Date.UTC(ano, mes - 1, dia));

    const existe = d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;

    const data = `${ano}-${doisDigitos(mes)}-${doisDigitos(dia)}`;

    if (existe && data >= hoje) {
      return data;
    }
  }

  return null;
}

/*
 * Comandos do bot (todos no privado). O texto do /ajuda e os menus
 * (setMyCommands) saem daqui; o teste confere que a ajuda cita todos os
 * comandos tratados em processarUpdateTelegram.
 */
const COMANDOS_VENDEDOR = [{ command: "ajuda", description: "Mostra os comandos que você pode usar" }];

const COMANDOS_ADMIN = [
  ...COMANDOS_VENDEDOR,
  { command: "ranking", description: "Atendimentos assumidos por vendedor (mês e total)" },
  { command: "fechar", description: "Fecha a loja o dia inteiro: /fechar [DD/MM]" },
  { command: "abrir", description: "Cancela um fechamento: /abrir [DD/MM]" },
  { command: "fechamentos", description: "Lista os fechamentos e a abertura manual ativa" },
  { command: "abrir_agora", description: "Abre a loja agora: /abrir_agora [minutos]" },
  { command: "cancelar_abertura", description: "Encerra a abertura manual" },
];

const AJUDA_ASSUMIR = [
  "Botão 🔒 ASSUMIR ATENDIMENTO (no resumo que chega no grupo): quem apertar primeiro fica com o cliente.",
  "Os dados do cliente e o botão para abrir o WhatsApp dele (com uma mensagem pronta) chegam aqui no seu privado,",
  "e o cliente recebe um aviso de que você vai chamá-lo. Para poder assumir, envie /start aqui uma vez.",
].join(" ");

const AJUDA_VENDEDOR = ["Comandos que você pode usar (aqui no privado):", "/ajuda: mostra esta lista.", "", AJUDA_ASSUMIR].join("\n");

const AJUDA_ADMIN = [
  AJUDA_VENDEDOR,
  "",
  "Comandos de administrador (aqui no privado; horários de Belém):",
  "/ranking: atendimentos assumidos por vendedor no mês e no total.",
  "/fechar [DD/MM]: fecha a loja o dia inteiro (sem data: hoje). Ex.: /fechar 25/12",
  "/abrir [DD/MM]: cancela um fechamento marcado (sem data: hoje). Ex.: /abrir 25/12",
  "/fechamentos: lista os fechamentos marcados e a abertura manual ativa.",
  "/abrir_agora [minutos]: abre a loja agora por 5 a 720 minutos (sem número: 60), mesmo fora do horário ou em dia fechado. Ex.: /abrir_agora 90",
  "/cancelar_abertura: encerra a abertura manual na hora.",
].join("\n");

/**
 * Textos do /ajuda (exportados para os testes).
 */
export function textoAjuda(admin: boolean): string {
  return admin ? AJUDA_ADMIN : AJUDA_VENDEDOR;
}

/*
 * Menu de comandos: falha só gera aviso no log (nunca derruba nada).
 */
async function chamarMenu(metodo: "setMyCommands" | "deleteMyCommands", corpo: Record<string, unknown>, rotulo: string): Promise<void> {
  const resposta = await chamarTelegram(metodo, corpo);

  if (!resposta.ok) {
    console.warn(`[Telegram] aviso: menu de comandos (${rotulo}) não atualizado.`);
  }
}

/**
 * No boot (idempotente): grupo sem menu; privado de todos só com /ajuda.
 */
export async function registrarMenuComandos(): Promise<void> {
  if (!telegramConfigurado()) {
    return;
  }

  await chamarMenu("setMyCommands", { commands: [], scope: { type: "all_group_chats" } }, "grupos");

  await chamarMenu("setMyCommands", { commands: COMANDOS_VENDEDOR, scope: { type: "all_private_chats" } }, "privado");
}

/**
 * Menu do chat privado de UMA pessoa: completo se for administrador; se
 * não for, o escopo próprio é apagado (volta ao menu do privado de todos).
 */
async function definirMenuDoChat(chatId: number, admin: boolean): Promise<void> {
  const scope = { type: "chat", chat_id: chatId };

  if (admin) {
    await chamarMenu("setMyCommands", { commands: COMANDOS_ADMIN, scope }, "administrador");
  } else {
    await chamarMenu("deleteMyCommands", { scope }, "privado de um vendedor");
  }
}

/**
 * /ajuda no privado: qualquer membro do grupo; mostra só o que a pessoa
 * pode usar e acerta o menu do chat dela.
 */
async function processarAjudaPrivado(mensagem: TelegramMensagem): Promise<void> {
  const usuario = mensagem.from;

  if (!usuario || usuario.is_bot) {
    return;
  }

  const responder = (texto: string) =>
    chamarTelegram("sendMessage", { chat_id: mensagem.chat.id, text: texto });

  const status = await statusNoGrupo(usuario.id);

  if (status === null) {
    await responder(MENSAGEM_VERIFICACAO_FALHOU);

    return;
  }

  if (!STATUS_AUTORIZADOS.has(status)) {
    await responder(MENSAGEM_FORA_DA_EQUIPE);

    return;
  }

  const admin = STATUS_ADMINISTRADORES.has(status);

  await responder(textoAjuda(admin));

  await definirMenuDoChat(mensagem.chat.id, admin);

  console.log(`[Telegram] /ajuda respondido (user_id ${mascararIdTelegram(usuario.id)}, ${admin ? "administrador" : "vendedor"}).`);
}

/*
 * Abertura manual temporária: de 5 a 720 minutos; sem número, 60.
 */
const ABERTURA_PADRAO_MIN = 60;

const ABERTURA_MIN_MIN = 5;

const ABERTURA_MAX_MIN = 720;

const USO_ABRIR_AGORA = `Uso: /abrir_agora [minutos], de ${ABERTURA_MIN_MIN} a ${ABERTURA_MAX_MIN} (sem número: ${ABERTURA_PADRAO_MIN}). Ex.: /abrir_agora 90`;

/**
 * Aviso curto no grupo dos vendedores (abertura manual). Falha: só log.
 */
async function avisarGrupoAbertura(texto: string): Promise<void> {
  const resposta = await chamarTelegram("sendMessage", { chat_id: config().chatId, text: texto });

  if (!resposta.ok) {
    console.error("[Loja] aviso de abertura manual não publicado no grupo.");
  }
}

/**
 * Recuperação na partida: uma abertura manual ainda válida volta a valer.
 */
export function restaurarAberturaManual(abertura: AberturaManual | null): void {
  definirAberturaManual(abertura);
}

/**
 * Chamada a cada 30 s: a abertura manual que venceu sai da memória e o
 * grupo é avisado (uma vez). A loja já volta ao normal no próprio fim.
 */
export async function verificarFimAberturaManual(agora = Date.now()): Promise<void> {
  const abertura = aberturaManualRegistrada();

  if (!abertura || agora < abertura.fim) {
    return;
  }

  definirAberturaManual(null);

  console.log("[Loja] abertura manual encerrada (fim do prazo).");

  if (telegramConfigurado()) {
    await avisarGrupoAbertura(`Abertura manual encerrada às ${horarioDaLoja(abertura.fim, agora)}. A loja volta ao horário normal.`);
  }
}

/**
 * /abrir_agora [minutos] e /cancelar_abertura, no privado, só para
 * administradores do grupo.
 */
async function processarAberturaPrivado(
  mensagem: TelegramMensagem,
  comando: "abrir_agora" | "cancelar_abertura",
  argumento: string,
): Promise<void> {
  const usuario = mensagem.from;

  if (!usuario || usuario.is_bot) {
    return;
  }

  const responder = (texto: string) =>
    chamarTelegram("sendMessage", { chat_id: mensagem.chat.id, text: texto });

  if (!(await verificarAdministrador(usuario, responder, `/${comando}`))) {
    return;
  }

  const admin = mascararIdTelegram(usuario.id);

  const quem = primeiroNomeVendedor(nomeDoUsuario(usuario)) ?? "um administrador";

  if (comando === "cancelar_abertura") {
    if (!aberturaManualAtiva()) {
      await responder("Não há abertura manual ativa.");

      return;
    }

    definirAberturaManual(null);

    const cancelado = await cancelarAberturaManual();

    console.log(`[Loja] abertura manual cancelada por admin ${admin}`);

    await responder(
      "Abertura manual cancelada. A loja volta ao horário normal." +
        (cancelado ? "" : " (Não consegui gravar no banco: a abertura pode voltar depois de um reinício.)"),
    );

    await avisarGrupoAbertura(`Abertura manual cancelada por ${quem}. A loja volta ao horário normal.`);

    return;
  }

  const minutos = argumento === "" ? ABERTURA_PADRAO_MIN : /^\d{1,4}$/.test(argumento) ? Number(argumento) : Number.NaN;

  if (!(minutos >= ABERTURA_MIN_MIN && minutos <= ABERTURA_MAX_MIN)) {
    await responder(USO_ABRIR_AGORA);

    return;
  }

  const inicio = Date.now();

  const fim = inicio + minutos * 60_000;

  const id = await gravarAberturaManual(new Date(inicio), new Date(fim), String(usuario.id));

  definirAberturaManual({ id, inicio, fim });

  const ate = horarioDaLoja(fim, inicio);

  console.log(`[Loja] abertura manual por ${minutos} min por admin ${admin}`);

  await responder(
    `Loja aberta manualmente até ${ate} (America/Belem).` +
      (id ? "" : " (Não consegui gravar no banco: vale até o próximo reinício.)"),
  );

  await avisarGrupoAbertura(`Loja aberta manualmente até ${ate} por ${quem}.`);
}

/**
 * /fechar [DD/MM], /abrir [DD/MM] e /fechamentos, no privado, só para
 * administradores do grupo. O fechamento vale o dia inteiro (Belém).
 */
async function processarFechamentoPrivado(
  mensagem: TelegramMensagem,
  comando: "fechar" | "abrir" | "fechamentos",
  argumento: string,
): Promise<void> {
  const usuario = mensagem.from;

  if (!usuario || usuario.is_bot) {
    return;
  }

  const responder = (texto: string) =>
    chamarTelegram("sendMessage", { chat_id: mensagem.chat.id, text: texto });

  if (!(await verificarAdministrador(usuario, responder, `/${comando}`))) {
    return;
  }

  const hoje = dataLocal();

  const anoAtual = hoje.slice(0, 4);

  if (comando === "fechamentos") {
    const lista = listarDiasFechados(hoje);

    const abertura = aberturaManualAtiva();

    const textoFechamentos =
      lista.length === 0
        ? "Nenhum fechamento marcado de hoje em diante."
        : ["Fechamentos marcados (a loja não atende o dia inteiro):", ...lista.map((d) => `• ${descreverDia(d, anoAtual)}`)].join("\n");

    await responder(
      abertura
        ? `Abertura manual ativa até ${horarioDaLoja(abertura.fim)} (America/Belem).\n\n${textoFechamentos}`
        : textoFechamentos,
    );

    console.log(`[Loja] /fechamentos respondido (${lista.length})`);

    return;
  }

  const data = interpretarDia(argumento, hoje);

  if (data === null) {
    await responder(`Data inválida. Use /${comando} DD/MM (ex.: /${comando} 25/12) ou só /${comando} para hoje.`);

    return;
  }

  const extenso = descreverDia(data, anoAtual);

  const ddmm = `${data.slice(8, 10)}/${data.slice(5, 7)}`;

  const admin = mascararIdTelegram(usuario.id);

  if (comando === "fechar") {
    const novo = adicionarDiaFechado(data);

    const gravado = await gravarFechamento(data, String(usuario.id));

    console.log(`[Loja] fechamento manual em ${ddmm} por admin ${admin}`);

    await responder(
      `${novo ? "Loja marcada como fechada" : "A loja já estava marcada como fechada"} em ${extenso}. Quem mandar mensagem recebe o aviso de loja fechada.` +
        (gravado ? "" : " (Não consegui gravar no banco: vale até o próximo reinício.)"),
    );

    return;
  }

  const existia = removerDiaFechado(data);

  const removido = await apagarFechamento(data);

  if (existia) {
    console.log(`[Loja] fechamento de ${ddmm} removido por admin ${admin}`);
  }

  await responder(
    (existia ? `Fechamento de ${extenso} removido. A loja segue o horário normal nesse dia.` : `Não havia fechamento marcado em ${extenso}.`) +
      (removido ? "" : " (Não consegui remover do banco: o fechamento pode voltar no próximo reinício.)"),
  );
}

async function processarRankingPrivado(mensagem: TelegramMensagem): Promise<void> {
  const usuario = mensagem.from;

  if (!usuario || usuario.is_bot) {
    return;
  }

  const responder = (texto: string) =>
    chamarTelegram("sendMessage", { chat_id: mensagem.chat.id, text: texto });

  if (!(await verificarAdministrador(usuario, responder, "/ranking"))) {
    return;
  }

  const ranking = await consultarRanking();

  if (ranking === null) {
    await responder(MENSAGEM_RANKING_ERRO);

    return;
  }

  if (ranking.length === 0) {
    await responder(MENSAGEM_RANKING_VAZIO);

    console.log("[Telegram] /ranking respondido (vazio)");

    return;
  }

  const mes = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Belem",
    month: "long",
    year: "numeric",
  }).format(Date.now());

  await responder(
    [
      "🏆 ATENDIMENTOS ASSUMIDOS",
      `Mês: ${mes}`,
      "",
      ...ranking.map(
        (linha, indice) =>
          `${indice + 1}. ${linha.nome}: ${linha.mes} no mês | ${linha.total} no total`,
      ),
    ].join("\n"),
  );

  console.log(`[Telegram] /ranking respondido (${ranking.length} vendedores)`);
}

/**
 * Processa um Update recebido em POST /telegram/webhook.
 *
 * Só /start e /ranking em conversa privada e callback_query.
 * Todo o resto (inclusive comandos no grupo) é ignorado.
 */
export async function processarUpdateTelegram(update: TelegramUpdate): Promise<void> {
  if (typeof update?.update_id === "number" && jaProcessado(`up:${update.update_id}`)) {
    return;
  }

  /*
   * Vendedor com nome novo no Telegram: o aviso e o link seguintes já
   * usam o nome atual.
   */
  await atualizarNomeVendedor(update.callback_query?.from ?? update.message?.from);

  if (update.callback_query) {
    await processarCallback(update.callback_query);

    return;
  }

  const mensagem = update.message;

  if (
    mensagem &&
    mensagem.chat?.type === "private" &&
    typeof mensagem.text === "string" &&
    /^\/start(?:@\w+)?(?:\s|$)/.test(mensagem.text.trim())
  ) {
    await processarStartPrivado(mensagem);

    return;
  }

  if (
    mensagem &&
    mensagem.chat?.type === "private" &&
    typeof mensagem.text === "string" &&
    /^\/ajuda(?:@\w+)?(?:\s|$)/.test(mensagem.text.trim())
  ) {
    await processarAjudaPrivado(mensagem);

    return;
  }

  if (
    mensagem &&
    mensagem.chat?.type === "private" &&
    typeof mensagem.text === "string" &&
    /^\/ranking(?:@\w+)?(?:\s|$)/.test(mensagem.text.trim())
  ) {
    await processarRankingPrivado(mensagem);

    return;
  }

  const abertura =
    mensagem && mensagem.chat?.type === "private" && typeof mensagem.text === "string"
      ? /^\/(abrir_agora|cancelar_abertura)(?:@\w+)?(?:\s+(.*))?$/.exec(mensagem.text.trim())
      : null;

  if (mensagem && abertura) {
    await processarAberturaPrivado(mensagem, abertura[1] as "abrir_agora" | "cancelar_abertura", (abertura[2] ?? "").trim());

    return;
  }

  const fechamento =
    mensagem && mensagem.chat?.type === "private" && typeof mensagem.text === "string"
      ? /^\/(fechar|abrir|fechamentos)(?:@\w+)?(?:\s+(.*))?$/.exec(mensagem.text.trim())
      : null;

  if (mensagem && fechamento) {
    await processarFechamentoPrivado(
      mensagem,
      fechamento[1] as "fechar" | "abrir" | "fechamentos",
      (fechamento[2] ?? "").trim(),
    );
  }
}
