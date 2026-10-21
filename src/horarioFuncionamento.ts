/*
 * Horário de funcionamento da Loja Exemplo.
 *
 * Toda a configuração fica aqui.
 * Feriados e folgas: fechamento manual pelo Telegram (/fechar),
 * dia inteiro em America/Belem (DIAS FECHADOS abaixo).
 */

type Expediente = {
  /*
   * "HH:MM", horário local da loja.
   */
  abre: string;

  /*
   * "HH:MM". A loja fecha neste minuto
   * (19:00 já é fechado).
   */
  fecha: string;
};

/*
 * Índice = dia da semana (0 = domingo ... 6 = sábado).
 * null = fechado o dia inteiro.
 */
type ExpedienteSemanal = readonly [
  Expediente | null,
  Expediente | null,
  Expediente | null,
  Expediente | null,
  Expediente | null,
  Expediente | null,
  Expediente | null,
];

export const FUSO_HORARIO_LOJA = "America/Belem";

export const EXPEDIENTE_LOJA: ExpedienteSemanal = [
  /* domingo */ null,
  /* segunda */ { abre: "08:00", fecha: "19:00" },
  /* terça   */ { abre: "08:00", fecha: "19:00" },
  /* quarta  */ { abre: "08:00", fecha: "19:00" },
  /* quinta  */ { abre: "08:00", fecha: "19:00" },
  /* sexta   */ { abre: "08:00", fecha: "19:00" },
  /* sábado  */ { abre: "08:00", fecha: "15:00" },
];

/*
 * Enviada uma única vez por período fechado
 * quando o cliente escreve fora do horário.
 */
export const MENSAGEM_LOJA_FECHADA =
  "Olá! No momento a loja está fechada. Nosso horário de atendimento é de segunda a sexta, das 8h às 19h, e aos sábados, das 8h às 15h. Retornaremos durante o próximo horário de atendimento.";

/*
 * Enviada (uma vez por período) num dia fechado manualmente
 * pelo /fechar, no lugar da mensagem de fora do horário.
 */
export const MENSAGEM_DIA_FECHADO =
  "Olá! Hoje a loja não está funcionando. Retornaremos no próximo dia de atendimento.";

/*
 * Acrescentada ao encaminhamento para o vendedor
 * quando uma triagem iniciada antes do fechamento
 * termina com a loja já fechada.
 */
export const AVISO_ENCAMINHAMENTO_FORA_DO_HORARIO =
  "Como a loja já está fechada, o vendedor dará continuidade no próximo horário de atendimento.";

const DIAS_SEMANA: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatador = new Intl.DateTimeFormat("en-US", {
  timeZone: FUSO_HORARIO_LOJA,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

type MomentoLocal = {
  /*
   * "AAAA-MM-DD" no fuso da loja.
   */
  data: string;

  diaSemana: number;

  /*
   * Minutos desde 00:00 no fuso da loja.
   */
  minutos: number;
};

function momentoLocal(instante: number): MomentoLocal {
  const partes: Record<string, string> = {};

  for (const parte of formatador.formatToParts(new Date(instante))) {
    partes[parte.type] = parte.value;
  }

  return {
    data: `${partes.year}-${partes.month}-${partes.day}`,

    diaSemana: DIAS_SEMANA[partes.weekday ?? ""] ?? 0,

    minutos: Number(partes.hour) * 60 + Number(partes.minute),
  };
}

/*
 * Dias fechados manualmente ("AAAA-MM-DD", dia de Belém). A memória é
 * a fonte de verdade; o banco (tabela fechamentos) só a recarrega na
 * partida. Cada fechamento vale o dia inteiro e acaba sozinho à
 * meia-noite (a data muda).
 */
const diasFechados = new Set<string>();

/*
 * Dias reabertos (/abrir) desde a última carga: uma carga atrasada do
 * banco (mesclarDiasFechados) não os traz de volta.
 */
const diasReabertos = new Set<string>();

export function definirDiasFechados(datas: Iterable<string>): void {
  diasFechados.clear();

  diasReabertos.clear();

  for (const data of datas) {
    diasFechados.add(data);
  }
}

/**
 * Junta à memória os dias lidos do banco depois da partida (carga que
 * falhou e foi repetida), sem tirar nada e sem os dias reabertos
 * nesse meio-tempo. Devolve quantos entraram.
 */
export function mesclarDiasFechados(datas: Iterable<string>): number {
  let novos = 0;

  for (const data of datas) {
    if (!diasReabertos.has(data) && !diasFechados.has(data)) {
      diasFechados.add(data);

      novos++;
    }
  }

  return novos;
}

export function adicionarDiaFechado(data: string): boolean {
  const novo = !diasFechados.has(data);

  diasFechados.add(data);

  diasReabertos.delete(data);

  return novo;
}

export function removerDiaFechado(data: string): boolean {
  diasReabertos.add(data);

  return diasFechados.delete(data);
}

/**
 * Dias fechados de "desde" (AAAA-MM-DD) em diante, em ordem.
 */
export function listarDiasFechados(desde: string): string[] {
  return [...diasFechados].filter((data) => data >= desde).sort();
}

/**
 * Aviso para quem escreve com a loja fechada: dia fechado
 * manualmente (o dia inteiro) tem mensagem própria; fora do
 * horário normal, a mensagem com o horário de atendimento.
 */
export function mensagemLojaFechada(instante = Date.now()): string {
  return diasFechados.has(momentoLocal(instante).data) ? MENSAGEM_DIA_FECHADO : MENSAGEM_LOJA_FECHADA;
}

/**
 * Data ("AAAA-MM-DD") do instante no fuso da loja.
 */
export function dataLocal(instante = Date.now()): string {
  return momentoLocal(instante).data;
}

/**
 * Fim (meia-noite) do dia de Belém `diasDepois` dias depois do dia de
 * `instante` (0 = fim do próprio dia). Belém fica em UTC-3 o ano inteiro.
 */
export function fimDoDiaLocal(instante: number, diasDepois: number): number {
  return Date.parse(`${momentoLocal(instante).data}T00:00:00-03:00`) + (diasDepois + 1) * 24 * 60 * 60 * 1000;
}

function paraMinutos(horario: string): number {
  const [hora, minuto] = horario.split(":");

  return Number(hora) * 60 + Number(minuto);
}

/*
 * Abertura manual temporária (/abrir_agora): enquanto vale, a loja está
 * ABERTA para todo o fluxo, mesmo fora do horário e mesmo com o dia
 * fechado manualmente. Acaba sozinha no fim (lojaAberta compara com o
 * relógio). A memória é a fonte de verdade; o banco (aberturas_manuais)
 * só a recarrega na partida. id = linha no banco (null se não gravou).
 */
export type AberturaManual = { id: string | null; inicio: number; fim: number };

let aberturaManual: AberturaManual | null = null;

export function definirAberturaManual(abertura: AberturaManual | null): void {
  aberturaManual = abertura;
}

/**
 * A abertura manual registrada, mesmo já vencida (para avisar o fim).
 */
export function aberturaManualRegistrada(): AberturaManual | null {
  return aberturaManual;
}

/**
 * A abertura manual que vale no instante (null se não há ou já venceu).
 */
export function aberturaManualAtiva(instante = Date.now()): AberturaManual | null {
  return aberturaManual && instante >= aberturaManual.inicio && instante < aberturaManual.fim ? aberturaManual : null;
}

/**
 * "HH:MM" (e " de DD/MM" se não for hoje) no fuso da loja.
 */
export function horarioDaLoja(instante: number, referencia = Date.now()): string {
  const local = momentoLocal(instante);

  const hora = `${String(Math.floor(local.minutos / 60)).padStart(2, "0")}:${String(local.minutos % 60).padStart(2, "0")}`;

  return local.data === momentoLocal(referencia).data ? hora : `${hora} de ${local.data.slice(8, 10)}/${local.data.slice(5, 7)}`;
}

/**
 * Indica se a loja está aberta no instante informado.
 */
export function lojaAberta(instante = Date.now()): boolean {
  if (aberturaManualAtiva(instante)) {
    return true;
  }

  const local = momentoLocal(instante);

  const expediente = EXPEDIENTE_LOJA[local.diaSemana];

  if (!expediente || diasFechados.has(local.data)) {
    return false;
  }

  return (
    local.minutos >= paraMinutos(expediente.abre) &&
    local.minutos < paraMinutos(expediente.fecha)
  );
}

/**
 * Identifica o período fechado atual pela data
 * ("AAAA-MM-DD") da próxima abertura.
 *
 * Todas as mensagens entre um fechamento e a
 * abertura seguinte recebem a mesma chave.
 */
export function chavePeriodoFechado(instante = Date.now()): string {
  const hoje = momentoLocal(instante);

  const expedienteHoje = EXPEDIENTE_LOJA[hoje.diaSemana];

  if (expedienteHoje && !diasFechados.has(hoje.data) && hoje.minutos < paraMinutos(expedienteHoje.abre)) {
    return hoje.data;
  }

  /*
   * Próximo dia com expediente que não esteja fechado manualmente
   * (vários fechamentos seguidos são um período só).
   */
  for (let dias = 1; dias <= 400; dias++) {
    const dia = momentoLocal(instante + dias * 24 * 60 * 60 * 1000);

    if (EXPEDIENTE_LOJA[dia.diaSemana] && !diasFechados.has(dia.data)) {
      return dia.data;
    }
  }

  /*
   * Sem nenhum dia de expediente configurado.
   */
  return "sem-expediente";
}
