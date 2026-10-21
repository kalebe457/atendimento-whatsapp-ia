/*
 * Itens do pedido (produto + quantidade), um por linha.
 *
 * Guardados nos mesmos campos de sempre (resumo.produto e
 * resumo.quantidade, colunas produto/quantidade do banco), uma linha por
 * item e alinhados: "cimento\nareia" / "10 kg\na confirmar". Um item só
 * continua como antes ("Cimento" / "10 sacos"). Quantidade não informada
 * de nenhum item: "Não informado" (a etapa da quantidade é perguntada).
 *
 * Módulo puro (sem Claude nem Telegram): usado pela IA, pelo resumo do
 * grupo, pela DM, pelo link wa.me e pelo scripts/ver-atendimentos.
 */

export const NAO_INFORMADO = "Não informado";

export const QUANTIDADE_A_CONFIRMAR = "a confirmar";

export type ItemPedido = { produto: string; quantidade: string | null };

function informado(valor: string | null | undefined): boolean {
  const texto = (valor ?? "").trim();

  return texto !== "" && texto !== NAO_INFORMADO;
}

/**
 * produto/quantidade (uma linha por item) → itens. Quantidade vazia ou
 * "a confirmar" = null.
 */
export function itensDoResumo(produto: string | null | undefined, quantidade: string | null | undefined): ItemPedido[] {
  if (!informado(produto)) {
    return [];
  }

  const produtos = (produto ?? "").split("\n").map((linha) => linha.trim());

  const quantidades = informado(quantidade) ? (quantidade ?? "").split("\n").map((linha) => linha.trim()) : [];

  return produtos
    .map((nome, i) => {
      const q = quantidades[i] ?? "";

      return { produto: nome, quantidade: q === "" || q === QUANTIDADE_A_CONFIRMAR || q === NAO_INFORMADO ? null : q };
    })
    .filter((item) => item.produto !== "");
}

/**
 * itens → produto/quantidade (uma linha por item).
 */
export function camposDosItens(itens: ItemPedido[]): { produto: string; quantidade: string } {
  if (itens.length === 0) {
    return { produto: NAO_INFORMADO, quantidade: NAO_INFORMADO };
  }

  return {
    produto: itens.map((item) => item.produto).join("\n"),
    quantidade: itens.every((item) => item.quantidade === null)
      ? NAO_INFORMADO
      : itens.map((item) => item.quantidade ?? QUANTIDADE_A_CONFIRMAR).join("\n"),
  };
}

/**
 * Linhas "Itens:" do resumo (grupo, DM, ver-atendimentos):
 * "• {produto}: {quantidade}", "a confirmar" sem quantidade.
 */
export function linhasDeItens(produto: string | null | undefined, quantidade: string | null | undefined, cortar: (texto: string) => string = (t) => t): string[] {
  const itens = itensDoResumo(produto, quantidade);

  if (itens.length === 0) {
    return [`Itens: ${NAO_INFORMADO}`];
  }

  return ["Itens:", ...itens.map((item) => `• ${cortar(item.produto)}: ${cortar(item.quantidade ?? QUANTIDADE_A_CONFIRMAR)}`)];
}

/**
 * "a", "a e b", "a, b e c".
 */
export function listarEmTexto(partes: string[]): string {
  if (partes.length <= 1) {
    return partes[0] ?? "";
  }

  return `${partes.slice(0, -1).join(", ")} e ${partes.at(-1)}`;
}

/**
 * O pedido numa frase ("cimento (10 kg), areia e caixa d'água"), para o
 * link wa.me.
 */
export function pedidoEmTexto(produto: string | null | undefined, quantidade: string | null | undefined): string | null {
  const itens = itensDoResumo(produto, quantidade);

  if (itens.length === 0) {
    return null;
  }

  return listarEmTexto(itens.map((item) => (item.quantidade ? `${item.produto} (${item.quantidade})` : item.produto)));
}
