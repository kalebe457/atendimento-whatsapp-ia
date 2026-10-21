// Perguntas que só o vendedor responde (pergunta_comercial da Claude, com a reserva pelo texto):
// disponibilidade (pede só o nome e vai direto ao vendedor), pagamento/preço/prazo/outra (aviso + a
// pergunta da etapa; nunca vira item; na etapa do produto sem produto, vai ao vendedor), os dois casos
// reais de produção (nomes fictícios), a pergunta nova das observações e o encaminhamento por
// inatividade. IAClaude direto, Claude simulado (devolve a saída de cada chamada).
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
process.env.ANTHROPIC_API_KEY = "anthropic-falso";
(globalThis as any).fetch = async () => { throw new Error("rede externa bloqueada no teste"); };

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
const NI = "Não informado";
type It = { produto: string; quantidade: string };
type Saida = { nome?: string; produto?: string; quantidade?: string; observacoes?: string; itens?: It[]; classificacao?: string | null; comercial?: string | null; atendente?: boolean; acompanhamento?: boolean };
let proximas: Saida[] = [];
const chamadas: any[] = [];
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  chamadas.push(params);
  const s = proximas.shift() ?? {};
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: {
    resposta: "texto do modelo (o sistema substitui)", status: "IA", quantidade_aplicavel: true,
    produto_generico: false, pergunta_itens: "", varios_itens: false, itens: s.itens ?? [],
    ...(s.classificacao !== undefined ? { classificacao_resposta_nome: s.classificacao } : {}),
    // Ausente quando o teste não define: vale a reserva pelo texto.
    ...(s.comercial !== undefined ? { pergunta_comercial: s.comercial } : {}),
    ...(s.atendente !== undefined ? { pedido_atendente: s.atendente } : {}),
    ...(s.acompanhamento !== undefined ? { acompanhamento: s.acompanhamento } : {}),
    resumo: { nome: s.nome ?? NI, produto: s.produto ?? NI, quantidade: s.quantidade ?? NI, observacoes: s.observacoes ?? NI } } };
};

const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const logReal = console.log;
const logs: string[] = [];
console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
const ia = await import(B + "/src/iaClaude.ts");
const { linhasDeItens } = await import(B + "/src/itensPedido.ts");

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; logReal(`${c ? "OK  " : "FAIL"} ${t}`); };
const APRESENTACAO = "Olá! Seja bem-vindo(a) à loja Exemplo Materiais de Construção! Sou a assistente virtual e vou dar início ao seu atendimento.";
const NOME = "Para começarmos, qual é o seu nome?";
const E_NOME = "E qual é o seu nome?";
const PRODUTO = "Qual produto ou material você está procurando? Pode ser também a marca ou o modelo.";
const QTD = "Qual quantidade você precisa? Se ainda não souber, sem problema.";
const OBS = 'Quer acrescentar alguma observação para o vendedor? Se não, é só responder "não" que já te encaminho.';
const HUMANO = "Perfeito! Vou encaminhar seu atendimento para um vendedor da loja, que dará continuidade.";
const AV = ia.AVISOS_PERGUNTA_COMERCIAL;
let n = 0;
const novaConversa = () => {
  const conv = new ia.IAClaude(`ATD-00000F${String(++n).padStart(4, "0")}`);
  const cliente = { telefone: "5500900002500", status: "IA" as const, resumo: { nome: NI, telefone: "5500900002500", produto: NI, quantidade: NI, observacoes: NI } };
  const falar = async (texto: string, saida: Saida = {}) => { proximas = [saida]; const r = await conv.responder(texto, cliente); cliente.resumo = r.resumo; return r; };
  return Object.assign(falar, { ia: conv });
};
const itens = (r: { resumo: { produto: string; quantidade: string } }) => linhasDeItens(r.resumo.produto, r.resumo.quantidade).join("\n");

logReal("== Schema e prompt ==");
const c0 = novaConversa();
await c0("oi");
const schema = chamadas.at(-1).output_config.format.schema;
const instrucoes: string = chamadas.at(-1).system[0].text;
// O SDK passa o enum para a descrição; o código valida o valor (fora dos cinco = reserva pelo texto).
const campoComercial = schema.properties.pergunta_comercial;
ok(schema.required.includes("pergunta_comercial") && campoComercial.anyOf?.[0]?.type === "string" && campoComercial.anyOf?.[1]?.type === "null" &&
   ["disponibilidade", "preco", "prazo", "pagamento", "outra"].every((v) => String(campoComercial.anyOf[0].description).includes(v)),
  "schema: pergunta_comercial é disponibilidade | preco | prazo | pagamento | outra ou null");
ok(/pergunta_comercial/.test(instrucoes) && /cheque, cartão, pix, boleto, parcelamento, vales e programas de benefício/.test(instrucoes) && /nunca é produto, item, nome nem quantidade/.test(instrucoes),
  "prompt: tipos, o que conta como pagamento e \"a pergunta nunca é produto nem item\"");

logReal("\n== Caso real 1 (ATD-00000AA001, nome fictício): pergunta de pagamento ==");
const PERGUNTA_CHEQUE = "Gostaria de saber se vocês aceitam o cheque bora estudar?";
const OBS_CHEQUE = "Cliente quer saber se a loja aceita cheque Bora Estudar.";
const k1 = novaConversa();
ok((await k1("Bom dia")).resposta === `${APRESENTACAO}\n\n${NOME}`, "\"Bom dia\" → apresentação + nome");
let r = await k1(PERGUNTA_CHEQUE, { comercial: "pagamento", classificacao: "outro", observacoes: OBS_CHEQUE, produto: PERGUNTA_CHEQUE, itens: [{ produto: PERGUNTA_CHEQUE, quantidade: "" }] });
ok(r.resposta === `${AV.pagamento}\n\n${E_NOME}` && !r.resposta.includes("Desculpe"), `pagamento na etapa do nome: aviso + "E qual é o seu nome?" (sem "Desculpe"): ${JSON.stringify(r.resposta)}`);
ok(r.resumo.produto === NI && r.resumo.observacoes === OBS_CHEQUE && r.resumo.nome === NI, "a pergunta não vira produto nem nome; vai nas observações");
r = await k1("Joana", { nome: "Joana", classificacao: "nome_pessoa" });
ok(r.resposta === `Certo, Joana! ${PRODUTO}`, "nome → \"Certo, Joana!\" e o produto");
r = await k1(PERGUNTA_CHEQUE, { comercial: "pagamento", produto: PERGUNTA_CHEQUE, itens: [{ produto: PERGUNTA_CHEQUE, quantidade: "" }] });
ok(r.status === "HUMANO" && r.resposta === `${AV.pagamento}\n\n${HUMANO}`, "repetiu a pergunta na etapa do produto: aviso e vai ao vendedor");
ok(itens(r) === "Itens: Não informado" && r.resumo.observacoes === OBS_CHEQUE && r.resumo.nome === "Joana", `resumo: "Itens: Não informado" e a pergunta nas observações (${JSON.stringify(itens(r))})`);

logReal("\n== Caso real 1 sem o campo (reserva pelo texto) ==");
const k1b = novaConversa();
await k1b("Bom dia");
r = await k1b(PERGUNTA_CHEQUE, { classificacao: "outro" });
ok(r.resposta === `${AV.pagamento}\n\n${E_NOME}` && r.resumo.observacoes === `Cliente perguntou: "${PERGUNTA_CHEQUE}"`,
  "sem pergunta_comercial: a reserva reconhece pagamento; a mensagem vai às observações (a Claude não registrou)");
await k1b("Joana", { nome: "Joana", classificacao: "nome_pessoa" });
r = await k1b(PERGUNTA_CHEQUE);
ok(r.status === "HUMANO" && itens(r) === "Itens: Não informado" && r.resumo.produto === NI, "repetida na etapa do produto: vendedor, sem a pergunta como item (nem pelo fallback da etapa)");

logReal("\n== Caso real 2 (ATD-00000AA002, nome fictício): disponibilidade ==");
const TINTA = "tinta branco neve";
const k2 = novaConversa();
r = await k2("Bom dia! Vocês tem tinta branco neve?", { comercial: "disponibilidade", produto: TINTA, itens: [{ produto: TINTA, quantidade: "" }], observacoes: "Cliente perguntou se tem tinta branco neve em estoque." });
ok(r.status === "IA" && r.resposta === `${APRESENTACAO}\n\n${AV.disponibilidade}\n\n${NOME}`, "1ª mensagem: apresentação + \"quem confirma o estoque é o vendedor\" + só o nome");
ok(itens(r) === `Itens:\n• ${TINTA}: a confirmar` && r.resumo.observacoes === `Cliente quer saber se tem ${TINTA}.`,
  "o produto vai nos itens (a confirmar) e a observação é a do sistema (a da Claude sobre o estoque sai)");
r = await k2("Wanda", { nome: "Wanda", classificacao: "nome_pessoa" });
ok(r.status === "HUMANO" && r.resposta === "Certo, Wanda! Vou encaminhar seu atendimento para um vendedor da loja, que dará continuidade.",
  "com o nome: direto ao vendedor (sem quantidade nem observações)");
ok(itens(r) === `Itens:\n• ${TINTA}: a confirmar` && r.resumo.observacoes === `Cliente quer saber se tem ${TINTA}.` && r.resumo.nome === "Wanda", "resumo com o item e \"Cliente quer saber se tem tinta branco neve.\"");

logReal("\n== Disponibilidade com o nome já informado ==");
const d1 = novaConversa();
await d1("oi");
await d1("Ana", { nome: "Ana", classificacao: "nome_pessoa" });
r = await d1("vocês tem cimento CP-II?", { comercial: "disponibilidade", produto: "cimento CP-II", itens: [{ produto: "cimento CP-II", quantidade: "" }] });
ok(r.status === "HUMANO" && r.resposta === `${AV.disponibilidade}\n\n${HUMANO}` && r.resumo.observacoes === "Cliente quer saber se tem cimento CP-II.",
  "etapa do produto, nome já conhecido: encaminha na hora");
const d2 = novaConversa();
await d2("oi");
await d2("Ana", { nome: "Ana", classificacao: "nome_pessoa" });
await d2("cimento", { produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] });
r = await d2("tem areia também?", { comercial: "disponibilidade", itens: [{ produto: "cimento", quantidade: "" }, { produto: "areia", quantidade: "" }], observacoes: "Pedido urgente." });
ok(r.status === "HUMANO" && itens(r) === "Itens:\n• cimento: a confirmar\n• areia: a confirmar" && r.resumo.observacoes === "Pedido urgente. Cliente quer saber se tem areia.",
  "etapa da quantidade: encaminha; a observação fala do item novo e junta com as outras");
const d3 = novaConversa();
r = await d3("Sou a Ana, vocês tem cimento?", { nome: "Ana", comercial: "disponibilidade", produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] });
ok(r.status === "HUMANO" && r.resposta === `${APRESENTACAO}\n\nCerto, Ana! ${AV.disponibilidade}\n\nVou encaminhar seu atendimento para um vendedor da loja, que dará continuidade.`,
  "nome e pergunta na 1ª mensagem: apresentação, \"Certo, Ana!\", aviso e vendedor");

logReal("\n== Pagamento, preço e prazo em cada etapa ==");
const e1 = novaConversa();
await e1("oi");
r = await e1("aceita cartão?", { comercial: "pagamento", classificacao: "outro", observacoes: "Cliente quer saber se aceita cartão." });
ok(r.resposta === `${AV.pagamento}\n\n${E_NOME}` && r.resumo.observacoes === "Cliente quer saber se aceita cartão." && r.resumo.nome === NI, "\"aceita cartão?\" na etapa do nome: aviso + nome");
r = await e1("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
ok(r.resposta === `Certo, Bia! ${PRODUTO}`, "a pergunta comercial não contou como tentativa do nome: segue normal");
const e2 = novaConversa();
await e2("oi");
await e2("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
r = await e2("parcela?", { comercial: "pagamento", observacoes: "Cliente quer saber se pode parcelar." });
ok(r.status === "HUMANO" && itens(r) === "Itens: Não informado" && r.resumo.observacoes === "Cliente quer saber se pode parcelar." && r.resposta === `${AV.pagamento}\n\n${HUMANO}`,
  "\"parcela?\" na etapa do produto: vendedor, sem itens, pergunta nas observações");
const e3 = novaConversa();
await e3("oi");
await e3("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
await e3("cimento", { produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] });
r = await e3("quanto custa?", { comercial: "preco", observacoes: "Cliente quer saber o preço." });
ok(r.status === "IA" && r.resposta === `${AV.preco}\n\n${QTD}` && r.resumo.quantidade === NI && itens(r) === "Itens:\n• cimento: a confirmar", "preço na etapa da quantidade: aviso + a quantidade de novo; nada vira quantidade");
const e4 = novaConversa();
await e4("oi");
await e4("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
await e4("cimento", { produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] });
r = await e4("entrega amanhã?", { comercial: "prazo", observacoes: "Cliente quer saber se entrega amanhã." });
ok(r.resposta === `${AV.prazo}\n\n${QTD}` && r.resumo.observacoes === "Cliente quer saber se entrega amanhã.", "prazo na etapa da quantidade: aviso de prazo + quantidade");
r = await e4("10 sacos", { quantidade: "10 sacos", itens: [{ produto: "cimento", quantidade: "10 sacos" }] });
ok(r.status === "HUMANO" && r.resposta === HUMANO, "observações já preenchidas pela pergunta: depois da quantidade vai ao vendedor");
const e5 = novaConversa();
await e5("oi");
r = await e5("vocês abrem domingo?", { comercial: "outra", classificacao: "outro", observacoes: "Cliente quer saber se a loja abre domingo." });
ok(r.resposta === `${AV.outra}\n\n${E_NOME}`, "\"outra\" na etapa do nome: aviso genérico do vendedor + nome");

logReal("\n== Produto com qualificador comercial na etapa do produto (regressão ATD real) ==");
const naEtapaDoProduto = async () => { const c = novaConversa(); await c("oi"); await c("Bia", { nome: "Bia", classificacao: "nome_pessoa" }); return c; };
let q = await naEtapaDoProduto();
r = await q("Lajotas em promoção", { comercial: "outra", itens: [{ produto: "Lajotas em promoção", quantidade: "" }] });
ok(r.status === "IA" && r.resposta === QTD && itens(r) === "Itens:\n• Lajotas: a confirmar" && r.resumo.observacoes === "Cliente procura lajotas em promoção.",
  `caso real: "Lajotas em promoção" (a Claude marcou "outra" e o item igual à mensagem): item, observação e a quantidade (${JSON.stringify(r.resposta)} / ${JSON.stringify(itens(r))} / ${JSON.stringify(r.resumo.observacoes)})`);
q = await naEtapaDoProduto();
r = await q("Lajotas em promoção", { comercial: "outra", itens: [{ produto: "lajotas", quantidade: "" }], observacoes: "Cliente procura lajotas em promoção." });
ok(r.status === "IA" && r.resposta === QTD && itens(r) === "Itens:\n• lajotas: a confirmar" && r.resumo.observacoes === "Cliente procura lajotas em promoção.",
  "a Claude separou (item \"lajotas\" + observação): o mesmo resultado, sem aviso nem observação duplicada");
q = await naEtapaDoProduto();
r = await q("Lajotas em promoção", { comercial: "outra" });
ok(r.status === "IA" && r.resposta === QTD && itens(r) === "Itens:\n• Lajotas: a confirmar", "sem item da Claude: a resposta da etapa vira o produto (sem o qualificador)");
q = await naEtapaDoProduto();
r = await q("cimento mais barato", { comercial: "preco", itens: [{ produto: "cimento mais barato", quantidade: "" }] });
ok(r.status === "IA" && r.resposta === QTD && itens(r) === "Itens:\n• cimento: a confirmar" && r.resumo.observacoes === "Cliente procura cimento mais barato.",
  "\"cimento mais barato\" (a Claude marcou preço): item, observação e a quantidade, sem aviso");
q = await naEtapaDoProduto();
r = await q("tinta em oferta", { comercial: "outra" });
ok(r.status === "IA" && r.resposta === QTD && itens(r) === "Itens:\n• tinta: a confirmar" && r.resumo.observacoes === "Cliente procura tinta em oferta.",
  "\"tinta em oferta\": item, observação e a quantidade");
q = await naEtapaDoProduto();
r = await q("Lajotas em promoção antiderrapante", { comercial: null, itens: [{ produto: "Lajotas em promoção antiderrapante", quantidade: "" }] });
ok(r.status === "IA" && r.resposta === QTD && itens(r) === "Itens:\n• Lajotas antiderrapante: a confirmar" && r.resumo.observacoes === "Cliente procura lajotas em promoção antiderrapante.",
  "o caso de ontem (\"Lajotas em promoção antiderrapante\") continua indo para a quantidade");
q = await naEtapaDoProduto();
r = await q("aceita cartão?", { comercial: "pagamento", observacoes: "Cliente quer saber se aceita cartão." });
ok(r.status === "HUMANO" && itens(r) === "Itens: Não informado" && r.resposta === `${AV.pagamento}\n\n${HUMANO}`, "\"aceita cartão?\" (sem produto) continua indo ao vendedor sem item");
q = await naEtapaDoProduto();
r = await q("vocês abrem domingo?", { comercial: "outra", produto: "vocês abrem domingo?" });
ok(r.status === "HUMANO" && itens(r) === "Itens: Não informado", "\"vocês abrem domingo?\" (sem produto) também");
q = await naEtapaDoProduto();
r = await q("vocês fazem entrega no interior", { comercial: "prazo", itens: [{ produto: "vocês fazem entrega no interior", quantidade: "" }] });
ok(r.status === "HUMANO" && itens(r) === "Itens: Não informado", "pergunta sem \"?\" (\"vocês fazem entrega...\"): continua sem virar item");

logReal("\n== Reserva pelo texto (campo ausente ou inválido) ==");
const f1 = novaConversa();
await f1("oi");
r = await f1("aceita cartão?", { classificacao: "outro" });
ok(r.resposta === `${AV.pagamento}\n\n${E_NOME}`, "\"aceita cartão?\" sem o campo: reserva → pagamento");
const f2 = novaConversa();
await f2("oi");
await f2("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
r = await f2("parcela?", { comercial: "talvez" });
ok(r.status === "HUMANO" && itens(r) === "Itens: Não informado", "\"parcela?\" com valor inválido: reserva → pagamento (vendedor, sem itens)");
const f3 = novaConversa();
await f3("oi");
await f3("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
r = await f3("cimento, quanto custa?", { produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] });
ok(r.resposta === `${ia.AVISO_PERGUNTA_COMERCIAL}\n\n${QTD}` && r.resumo.observacoes === NI, "preço sem o campo: aviso genérico de antes e a triagem segue (sem observação inventada)");
const f4 = novaConversa();
await f4("oi");
await f4("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
r = await f4("tem cimento?", { comercial: null, produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] });
ok(r.resposta === QTD, "a Claude disse null: sem aviso, mesmo com \"tem ...?\" no texto");

logReal("\n== Observações e reinício ==");
const g1 = novaConversa();
await g1("oi");
await g1("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
await g1("cimento", { produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] });
ok((await g1("10 sacos", { quantidade: "10 sacos", itens: [{ produto: "cimento", quantidade: "10 sacos" }] })).resposta === OBS, `pergunta nova das observações: ${JSON.stringify(OBS)}`);
r = await g1("não");
ok(r.status === "HUMANO" && r.resumo.observacoes === "Nenhuma observação adicional.", "\"não\" encaminha");
const h1 = new ia.IAClaude("ATD-00000F9999");
h1.restaurar({ triagem: { etapaAtual: "nome", perguntasEtapa: 1, etapasPuladas: [], apresentacaoPendente: false, quantidadeNaoAplicavel: false },
  resumo: { nome: NI, telefone: "5500900002500", produto: TINTA, quantidade: NI, observacoes: `Cliente quer saber se tem ${TINTA}.` }, historico: [], ultimaMensagemEm: Date.now() });
proximas = [{ nome: "Wanda", classificacao: "nome_pessoa" }];
r = await h1.responder("Wanda", { telefone: "5500900002500", status: "IA", resumo: { nome: NI, telefone: "5500900002500", produto: TINTA, quantidade: NI, observacoes: `Cliente quer saber se tem ${TINTA}.` } });
ok(r.status === "HUMANO", "depois de um reinício, a disponibilidade volta pela observação: com o nome, vai ao vendedor");

logReal("\n== Encaminhamento por inatividade (método da IA) ==");
const i1 = novaConversa();
await i1("oi");
await i1("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
await i1("cimento", { produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] });
ok(i1.ia.etapaAguardandoResposta() === "quantidade", "etapa aguardando resposta: quantidade");
r = i1.ia.encaminharPorInatividade("parou", true);
ok(r.status === "HUMANO" && r.resposta === "Vou passar sua mensagem para um vendedor da loja, que vai continuar o seu atendimento." && r.resumo.nome === "Bia" && itens(r) === "Itens:\n• cimento: a confirmar", "encaminha com o que tem e a mensagem normal");
ok(ia.textoEncaminhamentoAutomatico(true, true) === "Vou passar seu pedido para um vendedor da loja, que vai continuar o seu atendimento." &&
   ia.textoEncaminhamentoAutomatico(true, false) === "Vou passar seu pedido para um vendedor da loja, que vai te chamar no próximo horário de atendimento." &&
   ia.textoEncaminhamentoAutomatico(false, false) === "Vou passar sua mensagem para um vendedor da loja, que vai te chamar no próximo horário de atendimento.",
  "textos do encaminhamento automático (observações / outras etapas; loja aberta / fechada)");
ok(ia.NOME_DA_ETAPA.observacoes === "observações" && ia.NOME_DA_ETAPA.quantidade === "quantidade", "nomes das etapas para o aviso do resumo");

logReal("\n== Pedido de atendente (item 8) ==");
const PEDIU_DE = (msg: string) => `Cliente pediu para falar com um atendente: "${msg}".`;
const CERTO = "Certo! Vou passar seu atendimento para um vendedor da loja.";
ok(schema.required.includes("pedido_atendente") && schema.properties.pedido_atendente.type === "boolean" && /PEDIDO DE ATENDENTE/.test(instrucoes) && /não quero robô/.test(instrucoes),
  "schema: pedido_atendente (booleano, obrigatório); prompt com os exemplos");
const a1 = novaConversa();
r = await a1("falar com atendente", { atendente: true, produto: "Falar com atendente", itens: [{ produto: "Falar com atendente", quantidade: "" }] });
ok(r.status === "HUMANO" && r.resposta === `${APRESENTACAO}\n\n${CERTO}` && itens(r) === "Itens: Não informado" && r.resumo.observacoes === PEDIU_DE("falar com atendente") && r.resumo.nome === NI,
  "1ª mensagem (caso real: cliente que voltou e mandou \"falar com atendente\"): vendedor na hora, sem nome, sem virar item");
const a2 = novaConversa();
r = await a2("falar com atendente", { produto: "Falar com atendente", itens: [{ produto: "Falar com atendente", quantidade: "" }] });
ok(r.status === "HUMANO" && itens(r) === "Itens: Não informado" && r.resumo.observacoes === PEDIU_DE("falar com atendente"), "sem o campo da Claude: a reserva pelo texto reconhece \"falar com atendente\"");
const a3 = novaConversa();
await a3("oi");
r = await a3("quero falar com uma pessoa", { atendente: true, classificacao: "outro", nome: "Pessoa" });
ok(r.status === "HUMANO" && r.resposta === CERTO && r.resumo.nome === NI && r.resumo.observacoes === PEDIU_DE("quero falar com uma pessoa"), "etapa do nome: encaminha sem nome (nada do pedido vira nome)");
const a4 = novaConversa();
await a4("oi");
await a4("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
await a4("cimento e areia", { itens: [{ produto: "cimento", quantidade: "" }, { produto: "areia", quantidade: "" }] });
r = await a4("não quero robô, quero um vendedor", { atendente: true, observacoes: "Cliente quer falar com um vendedor.",
  itens: [{ produto: "cimento", quantidade: "" }, { produto: "areia", quantidade: "" }, { produto: "vendedor", quantidade: "" }] });
ok(r.status === "HUMANO" && itens(r) === "Itens:\n• cimento: a confirmar\n• areia: a confirmar" && r.resumo.observacoes === PEDIU_DE("não quero robô, quero um vendedor") && r.resumo.nome === "Bia" && r.resposta === CERTO,
  "etapa da quantidade: vendedor na hora, mantém os itens coletados, frase do cliente citada (a observação da Claude sai)");
const a5 = novaConversa();
await a5("oi");
await a5("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
r = await a5("vendedor", { atendente: false });
ok(r.status === "HUMANO" && itens(r) === "Itens: Não informado", "só \"vendedor\" na etapa do produto (reserva pelo texto): vendedor, sem item");
const a6 = novaConversa();
await a6("oi");
r = await a6("Bia", { nome: "Bia", classificacao: "nome_pessoa", atendente: false });
ok(r.status === "IA" && r.resposta === `Certo, Bia! ${PRODUTO}`, "sem pedido: a triagem segue normal");

logReal("\n== Pedido de atendente com as palavras do cliente (itens 14 e 15) ==");
const REAL = "Ola gostaria de falar com vendedor moreno de vugo sagramenta";
const b1 = novaConversa();
r = await b1(REAL, { atendente: true, observacoes: "Cliente quer falar com o vendedor Moreno, de vulgo Sacramento.", produto: "vendedor moreno" });
ok(r.status === "HUMANO" && r.resumo.observacoes === `Cliente pediu para falar com um atendente: "${REAL}".` && itens(r) === "Itens: Não informado",
  `caso real exato: a frase original, entre aspas, sem interpretar nem corrigir: ${JSON.stringify(r.resumo.observacoes)}`);
ok(r.resposta === `${APRESENTACAO}\n\n${CERTO}` && !r.resposta.includes("Perfeito"), "1ª mensagem: apresentação + \"Certo! Vou passar seu atendimento para um vendedor da loja.\" (sem \"Perfeito!\")");
const b2 = novaConversa();
await b2("oi");
await b2("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
await b2("cimento", { produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] });
r = await b2("10 sacos\nquero falar com o vendedor João\nobrigada", { atendente: true, quantidade: "10 sacos", itens: [{ produto: "cimento", quantidade: "10 sacos" }] });
ok(r.status === "HUMANO" && itens(r) === "Itens:\n• cimento: 10 sacos" && r.resumo.observacoes === PEDIU_DE("quero falar com o vendedor João"),
  "no meio da triagem, com outras mensagens no lote: itens mantidos e só a linha do pedido citada");
const LONGA = `quero falar com um vendedor ${"porque preciso de muita coisa para a obra ".repeat(8)}`.trim();
const b3 = novaConversa();
r = await b3(LONGA, { atendente: true });
const citada = /"(.*)"\.$/.exec(r.resumo.observacoes)?.[1] ?? "";
ok([...citada].length === 200 && citada.endsWith("…") && LONGA.startsWith(citada.slice(0, -1).trimEnd()), `mensagem longa: cortada em 200 caracteres com "…" (${[...citada].length})`);
const b4 = novaConversa();
await b4("oi");
r = await b4("pode me atender uma pessoa de verdade?", { atendente: true, classificacao: "outro" });
ok(r.resumo.observacoes === PEDIU_DE("pode me atender uma pessoa de verdade?"), "pedido reconhecido só pela Claude (nenhuma linha pela reserva): cita a mensagem toda");
ok(ia.observacaoPedidoAtendente("") === ia.OBSERVACAO_PEDIU_ATENDENTE, "sem texto: só \"Cliente pediu para falar com um atendente.\"");
const b5 = novaConversa();
await b5("oi");
await b5("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
await b5("cimento", { produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] });
await b5("10 sacos", { quantidade: "10 sacos", itens: [{ produto: "cimento", quantidade: "10 sacos" }] });
ok((await b5("não")).resposta === HUMANO, "encaminhamento normal (respondeu tudo) continua com \"Perfeito! Vou encaminhar...\"");

logReal("\n== Acompanhamento de pedido ou orçamento (B, casos reais com números fictícios) ==");
ok(schema.required.includes("acompanhamento") && schema.properties.acompanhamento.type === "boolean" && /ACOMPANHAMENTO DE PEDIDO/.test(instrucoes) && /ela mandou a mensagem aqui/.test(instrucoes),
  "schema: acompanhamento (booleano, obrigatório); prompt com os exemplos");
const ACOMP = (msg: string) => `Cliente falou de um pedido ou atendimento anterior: "${msg}".`;
const c1 = novaConversa();
r = await c1("Orçamento 12345678", { produto: "Orçamento 12345678", itens: [{ produto: "Orçamento 12345678", quantidade: "" }] });
ok(r.status === "HUMANO" && itens(r) === "Itens: Não informado" && r.resumo.observacoes === ACOMP("Orçamento 12345678") && r.resposta === `${APRESENTACAO}\n\n${CERTO}`,
  "\"Orçamento 12345678\" (sem o campo: reserva pelo texto): vendedor na hora, sem pedir nome, nunca item");
const c2 = novaConversa();
r = await c2("Orçamento 12345678\nVeja no sistema de vocês esse orçamento liberado hoje", { acompanhamento: true, itens: [{ produto: "orçamento liberado", quantidade: "" }], observacoes: "Cliente quer ver o orçamento." });
ok(r.status === "HUMANO" && itens(r) === "Itens: Não informado" && r.resumo.observacoes === ACOMP("Orçamento 12345678 Veja no sistema de vocês esse orçamento liberado hoje"),
  "as duas mensagens do caso real: nenhuma vira item; as palavras do cliente nas observações (a da Claude sai)");
const c3 = novaConversa();
await c3("oi");
r = await c3("Ela mandou a mensagem aqui", { acompanhamento: true, classificacao: "outro", itens: [{ produto: "Ela mandou a mensagem aqui", quantidade: "" }] });
ok(r.status === "HUMANO" && itens(r) === "Itens: Não informado" && r.resumo.nome === NI && r.resumo.observacoes === ACOMP("Ela mandou a mensagem aqui"),
  "\"Ela mandou a mensagem aqui\" na etapa do nome (só a Claude reconhece): vendedor, sem nome, não vira item");
const c4 = novaConversa();
await c4("oi");
await c4("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
await c4("cimento", { produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] });
r = await c4("já falei com o Carlos ontem", { acompanhamento: true });
ok(r.status === "HUMANO" && itens(r) === "Itens:\n• cimento: a confirmar" && r.resumo.observacoes === ACOMP("já falei com o Carlos ontem"), "no meio da triagem: itens coletados ficam");
const c5 = novaConversa();
await c5("oi");
r = await c5("Bia", { nome: "Bia", classificacao: "nome_pessoa", acompanhamento: false });
ok(r.status === "IA", "sem acompanhamento: a triagem segue");
const longo = `Orçamento 12345678 ${"preciso que alguém veja isso hoje ".repeat(10)}`.trim();
const c6 = novaConversa();
r = await c6(longo, { acompanhamento: true });
ok([...(/"(.*)"\.$/.exec(r.resumo.observacoes)?.[1] ?? "")].length === 200, "citação do acompanhamento: até 200 caracteres");

logReal("\n== Mídia sem texto (C) e nome sem \"Desculpe\" (D) ==");
const m1 = novaConversa();
const mi = m1.ia;
const cliM = { telefone: "5500900002500", status: "IA" as const, resumo: { nome: NI, telefone: "5500900002500", produto: NI, quantidade: NI, observacoes: NI } };
await mi.responderMidia({ tipo: "image", legenda: null }, cliM, Date.now());
ok(JSON.stringify(mi.midiaSemContinuacao()) === JSON.stringify(["imagem"]), "só imagem depois do aviso: mídia sem texto");
r = mi.encaminharPorInatividade("midia", true);
ok(r.status === "HUMANO" && itens(r) === "Itens:\n• produto da imagem enviada: a confirmar" && r.resumo.observacoes === "Cliente enviou imagem sem texto." && r.resposta.endsWith("Vou passar sua mensagem para um vendedor da loja, que vai continuar o seu atendimento."),
  "encaminhada (item \"produto da imagem enviada\"): \"Cliente enviou imagem sem texto.\" e \"Vou passar sua mensagem...\"");
const m2 = novaConversa();
await m2.ia.responderMidia({ tipo: "document", legenda: null }, cliM, Date.now());
await m2("oi");
ok(m2.ia.midiaSemContinuacao() === null, "mandou texto depois da mídia: não é mídia sem texto");
const n1 = novaConversa();
await n1("oi");
r = await n1("tudo certo por aí?", { classificacao: "outro" });
ok(r.resposta === "E qual é o seu nome?" && !r.resposta.includes("Desculpe"), "mensagem que não é nome: \"E qual é o seu nome?\" (sem \"Desculpe\")");

logReal("\n== Resposta sem conteúdo depois de uma pergunta (item 9) ==");
const v1 = novaConversa();
await v1("oi");
await v1("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
ok((await v1("cimento, quanto custa?", { produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] })).resposta === `${ia.AVISO_PERGUNTA_COMERCIAL}\n\n${QTD}`, "aviso + pergunta da quantidade");
r = await v1("Ok");
ok(r.resposta === "E a quantidade, você já sabe? Se não souber, sem problema.", `caso real: "Ok" depois do aviso → variação curta, não a pergunta idêntica: ${JSON.stringify(r.resposta)}`);
const v2 = novaConversa();
await v2("oi");
r = await v2("ok");
ok(r.resposta === "E qual é o seu nome?", `"ok" na etapa do nome: "E qual é o seu nome?" (sem "Desculpe"): ${JSON.stringify(r.resposta)}`);
const v3 = novaConversa();
await v3("oi");
await v3("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
await v3("cimento", { produto: "cimento", itens: [{ produto: "cimento", quantidade: "" }] });
await v3("10 sacos", { quantidade: "10 sacos", itens: [{ produto: "cimento", quantidade: "10 sacos" }] });
r = await v3("tá");
ok(r.resposta === 'Pode me dizer a observação? Se não tiver, é só responder "não".' && r.status === "IA", `"tá" nas observações: variação curta: ${JSON.stringify(r.resposta)}`);
r = await v3("certo");
ok(r.status === "HUMANO", "outra sem conteúdo: a etapa é pulada (2 perguntas) e vai ao vendedor");

logReal("\n== 21/10: quantidade respondida com medida ou especificação ==");
const ESPEC = (p: string) => `Certo, ${p}. E quantas você precisa? Se ainda não souber, sem problema.`;
const naEtapaDaQuantidade = async (produto: string) => {
  const c = novaConversa();
  await c("oi");
  await c("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
  await c(produto, { itens: [{ produto, quantidade: "" }] });
  return c;
};
let e = await naEtapaDaQuantidade("telhas");
r = await e("150x120", { itens: [{ produto: "telhas 150x120", quantidade: "" }] });
ok(r.status === "IA" && r.resposta === ESPEC("telhas 150x120") && itens(r) === "Itens:\n• telhas 150x120: a confirmar",
  `"150x120" (a Claude pôs a medida no produto): incorpora e pergunta com outra frase: ${JSON.stringify(r.resposta)}`);
r = await e("são as grandes", { itens: [{ produto: "telhas 150x120", quantidade: "" }] });
ok(r.status === "IA" && r.resposta === OBS && itens(r) === "Itens:\n• telhas 150x120: a confirmar", "na segunda vez ainda sem quantidade: segue para as observações, com \"a confirmar\"");
e = await naEtapaDaQuantidade("tinta acrílica");
r = await e("18L", { itens: [{ produto: "tinta acrílica 18L", quantidade: "" }] });
ok(r.resposta === ESPEC("tinta acrílica 18L") && r.resumo.quantidade === NI, "\"18L\": vai para o produto, não para a quantidade (a reserva do texto não decide)");
e = await naEtapaDaQuantidade("porta");
r = await e("2,10m", { itens: [{ produto: "porta 2,10m", quantidade: "" }] });
ok(r.resposta === ESPEC("porta 2,10m"), "\"2,10m\": o mesmo");
r = await e("3 unidades", { itens: [{ produto: "porta 2,10m", quantidade: "3 unidades" }] });
ok(r.resposta === OBS && itens(r) === "Itens:\n• porta 2,10m: 3 unidades", "depois, a quantidade de verdade: registrada, segue para as observações");
e = await naEtapaDaQuantidade("telhas");
r = await e("40", { itens: [{ produto: "telhas", quantidade: "40" }] });
ok(r.resposta === OBS && itens(r) === "Itens:\n• telhas: 40", "quantidade normal na 1ª resposta: como antes");

logReal("\n== 21/10: notas repetidas nas observações ==");
ok(ia.unirNotasRepetidas("Cliente quer saber se tem tinta acrílica. Cliente quer saber marca e valor da tinta acrílica.") === "Cliente quer saber se tem tinta acrílica, marca e valor.",
  "\"se tem X\" + \"marca e valor de X\" viram uma só");
ok(ia.unirNotasRepetidas("Cliente quer saber marca e valor da tinta acrílica. Pedido urgente. Cliente quer saber se tem tinta acrílica.") === "Pedido urgente. Cliente quer saber se tem tinta acrílica, marca e valor.",
  "em qualquer ordem (a nota unida fica no lugar da \"se tem\"), mantendo as outras notas");
ok(ia.unirNotasRepetidas("Pedido urgente. Pedido urgente.") === "Pedido urgente.", "frase igual repetida sai");
ok(ia.unirNotasRepetidas("Cliente quer saber se tem cimento. Cliente quer saber se a loja aceita pix.") === "Cliente quer saber se tem cimento. Cliente quer saber se a loja aceita pix.",
  "perguntas sobre coisas diferentes ficam separadas");
const d9 = novaConversa();
await d9("oi");
await d9("Bia", { nome: "Bia", classificacao: "nome_pessoa" });
r = await d9("tem tinta acrílica? qual marca e valor?", { comercial: "disponibilidade", itens: [{ produto: "tinta acrílica", quantidade: "" }], observacoes: "Cliente quer saber marca e valor da tinta acrílica." });
ok(r.status === "HUMANO" && r.resumo.observacoes === "Cliente quer saber se tem tinta acrílica, marca e valor.", `no fluxo da disponibilidade: uma nota só (${JSON.stringify(r.resumo.observacoes)})`);

logReal("\n== 21/10: mídia com legenda sem continuação ==");
const ml = novaConversa();
await ml("oi");
const cliML = { telefone: "5500900002500", status: "IA" as const, resumo: { nome: NI, telefone: "5500900002500", produto: NI, quantidade: NI, observacoes: NI } };
await ml.ia.responderMidia({ tipo: "image", legenda: "Tem? Quanto?" }, cliML, Date.now());
ok(JSON.stringify(ml.ia.midiaSemContinuacao()) === JSON.stringify(["imagem"]), "texto antes e depois imagem com legenda, sem nada escrito: mídia sem continuação");
r = ml.ia.encaminharPorInatividade("midia", true);
ok(r.status === "HUMANO" && itens(r) === "Itens:\n• produto da imagem enviada: a confirmar" && r.resumo.observacoes === "Cliente enviou imagem perguntando: Tem? Quanto?",
  `encaminhada: item "produto da imagem enviada", a pergunta da legenda nas observações e sem "sem texto" (${JSON.stringify(r.resumo.observacoes)})`);
const ml2 = novaConversa();
await ml2.ia.responderMidia({ tipo: "image", legenda: "o modelo da minha casa" }, cliML, Date.now());
r = ml2.ia.encaminharPorInatividade("midia", true);
ok(r.resumo.observacoes === 'Cliente enviou imagem com a legenda: "o modelo da minha casa".', "legenda que não é pergunta: a legenda, sem \"sem texto\"");
const ml3 = novaConversa();
await ml3.ia.responderMidia({ tipo: "image", legenda: "Tem?" }, cliML, Date.now());
await ml3("quero esse piso", { itens: [{ produto: "piso", quantidade: "" }] });
ok(ml3.ia.midiaSemContinuacao() === null, "escreveu depois da mídia: segue a triagem normal");

logReal("\n== 21/10: nome da loja nos textos ==");
const fs = await import("node:fs");
const textosComNomeAntigo = fs.readdirSync(new URL("../src", import.meta.url)).filter((f: string) => f.endsWith(".ts"))
  .flatMap((f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").split("\n").map((l: string) => [f, l.trim()] as const))
  .filter(([, l]) => l.includes("Loja Exemplo") && !l.startsWith("*") && !l.startsWith("/") && !l.startsWith("//"));
ok(textosComNomeAntigo.every(([f, l]) => f === "iaClaude.ts" && (l.startsWith("Você é a assistente virtual") || l.startsWith("- informe que o atendimento"))),
  `"Loja Exemplo" só nas instruções da Claude (nunca enviadas): ${JSON.stringify(textosComNomeAntigo.map(([f]) => f))}`);
const { MENSAGEM_LOJA_FECHADA, MENSAGEM_DIA_FECHADO } = await import(B + "/src/horarioFuncionamento.ts");
ok(HUMANO === "Perfeito! Vou encaminhar seu atendimento para um vendedor da loja, que dará continuidade." && MENSAGEM_LOJA_FECHADA.startsWith("Olá! No momento a loja está fechada.") &&
   MENSAGEM_DIA_FECHADO.startsWith("Olá! Hoje a loja não está funcionando."), "encaminhamento e loja fechada: \"da loja\" / \"a loja\"");

logReal("\n== Logs ==");
ok(!logs.some((l) => ["Joana", "Wanda", "cheque", "tinta", "cartão"].some((t) => l.includes(t))), "nenhum log com o que o cliente disse");

await banco.encerrarBanco();
logReal(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
process.exit(falhas ? 1 : 0);
