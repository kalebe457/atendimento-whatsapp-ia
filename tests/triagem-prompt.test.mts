// Triagem: produto só como categoria (uma pergunta pelos itens), quantidade de vários itens numa pergunta,
// observações sem repetir produtos, nome fantasia na apresentação. IAClaude direto, Claude simulado
// (devolve a saída de cada chamada); o texto do prompt e do schema também é conferido.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
process.env.ANTHROPIC_API_KEY = "anthropic-falso";
(globalThis as any).fetch = async () => { throw new Error("rede externa bloqueada no teste"); };

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
const NI = "Não informado";
type Saida = { nome?: string; produto?: string; quantidade?: string; observacoes?: string; generico?: boolean; pergunta?: string; varios?: boolean; qtdAplicavel?: boolean; classificacao?: string | null };
let proximas: Saida[] = [];
const chamadas: any[] = [];
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  chamadas.push(params);
  const s = proximas.shift() ?? {};
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: {
    resposta: "texto do modelo (o sistema substitui)", status: "IA", quantidade_aplicavel: s.qtdAplicavel ?? true,
    produto_generico: s.generico ?? false, pergunta_itens: s.pergunta ?? "", varios_itens: s.varios ?? false,
    // Ausente quando o teste não define (como as respostas antigas): vale a lista de reserva.
    ...(s.classificacao !== undefined ? { classificacao_resposta_nome: s.classificacao } : {}),
    resumo: { nome: s.nome ?? NI, produto: s.produto ?? NI, quantidade: s.quantidade ?? NI, observacoes: s.observacoes ?? NI } } };
};

const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const logReal = console.log;
console.log = () => {};
const { IAClaude } = await import(B + "/src/iaClaude.ts");

let falhas = 0;
const ok = (c: boolean, t: string) => { if (!c) falhas++; logReal(`${c ? "OK  " : "FAIL"} ${t}`); };
const APRESENTACAO = "Olá! Seja bem-vindo(a) à loja Exemplo Materiais de Construção! Sou a assistente virtual e vou dar início ao seu atendimento.";
const NOME = "Para começarmos, qual é o seu nome?";
const PRODUTO = "Qual produto ou material você está procurando? Pode ser também a marca ou o modelo.";
const QTD = "Qual quantidade você precisa? Se ainda não souber, sem problema.";
const QTD_CADA = "Qual a quantidade de cada um? Se ainda não souber, sem problema.";
const OBS = 'Quer acrescentar alguma observação para o vendedor? Se não, é só responder "não" que já te encaminho.';
const ITENS_ELETRICOS = "Quais materiais elétricos você precisa? Por exemplo: fios, tomadas, disjuntores, lâmpadas.";
let n = 0;
const novaConversa = () => {
  const ia = new IAClaude(`ATD-00000E${String(++n).padStart(4, "0")}`);
  const cliente = { telefone: "5500900001900", status: "IA" as const, resumo: { nome: NI, telefone: "5500900001900", produto: NI, quantidade: NI, observacoes: NI } };
  return async (texto: string, saida: Saida = {}) => { proximas = [saida]; const r = await ia.responder(texto, cliente); cliente.resumo = r.resumo; return r; };
};

logReal("== Texto do prompt e do schema ==");
const conv0 = novaConversa();
await conv0("oi");
const p = chamadas.at(-1);
const instrucoes: string = p.system[0].text;
const schema = p.output_config.format.schema;
ok(p.system[0].cache_control?.type === "ephemeral", "instruções continuam no bloco cacheado");
ok(/só uma categoria/.test(instrucoes) && instrucoes.includes("produto_generico") && instrucoes.includes("pergunta_itens") && /uma vez só/.test(instrucoes) && /sem insistir/.test(instrucoes),
  "regra 1: categoria → uma pergunta pelos itens, sem insistir");
ok(instrucoes.includes("varios_itens") && /numa pergunta só/.test(instrucoes) && /realmente não se aplica/.test(instrucoes), "regra 2: quantidade de todos numa pergunta só; pular só quando não se aplica");
ok(/Nunca repita em observações/.test(instrucoes) && /resposta das observações/.test(instrucoes) && /forma de pagamento/.test(instrucoes) && instrucoes.includes('"Não informado"'),
  "regra 3: observações sem produtos, só o que não cabe nos outros campos");
ok(["produto_generico", "pergunta_itens", "varios_itens"].every((c) => schema.required.includes(c) && c in schema.properties), "schema com os três sinais novos (obrigatórios)");
ok(/Nunca repita aqui produtos/.test(schema.properties.resumo.properties.observacoes.description), "descrição de observações no schema também sem repetição");

logReal("\n== Caso comum: mesmo número de perguntas ==");
const c1 = novaConversa();
const r1 = [
  await c1("oi"),
  await c1("Ana", { nome: "Ana" }),
  await c1("cimento CP-II", { nome: "Ana", produto: "cimento CP-II" }),
  await c1("10 sacos", { nome: "Ana", produto: "cimento CP-II", quantidade: "10 sacos" }),
  await c1("não", { nome: "Ana", produto: "cimento CP-II", quantidade: "10 sacos" }),
];
ok(JSON.stringify(r1.map((r) => r.resposta)) === JSON.stringify([`${APRESENTACAO}\n\n${NOME}`, `Certo, Ana! ${PRODUTO}`, QTD, OBS, r1[4]!.resposta]) && r1[4]!.status === "HUMANO",
  "nome → produto (com \"Certo, Ana!\") → quantidade → observações → vendedor (4 perguntas, como antes)");
ok(r1[0]!.resposta.startsWith("Olá! Seja bem-vindo(a) à loja Exemplo Materiais de Construção!"), "apresentação com o nome fantasia");

logReal("\n== Produto só como categoria ==");
const c2 = novaConversa();
await c2("oi");
const g1 = await c2("Ana, quero materiais elétricos", { nome: "Ana", produto: "materiais elétricos", generico: true, pergunta: ITENS_ELETRICOS });
ok(g1.resposta === `Certo, Ana! ${ITENS_ELETRICOS}` && g1.status === "IA", "categoria: UMA pergunta pelos itens, com exemplos (no lugar da quantidade)");
const g2 = await c2("fios e tomadas", { nome: "Ana", produto: "fios e tomadas", varios: true });
ok(g2.resposta === QTD_CADA, "itens informados (vários): \"Qual a quantidade de cada um?\"");

const c3 = novaConversa();
await c3("oi");
await c3("Ana, material de construção", { nome: "Ana", produto: "material de construção", generico: true, pergunta: "Quais materiais você precisa? Por exemplo: cimento, areia, tijolos." });
const g3 = await c3("ainda não sei", { nome: "Ana", produto: "material de construção", generico: true, pergunta: "Quais materiais você precisa? Por exemplo: cimento, areia, tijolos." });
ok(g3.resposta === QTD, "cliente não detalhou: não insiste, segue para a quantidade");

const c4 = novaConversa();
const h1 = await c4("quero material hidráulico", { produto: "material hidráulico", generico: true, pergunta: "Quais materiais hidráulicos você precisa? Por exemplo: canos, conexões, registros." });
ok(h1.resposta === `${APRESENTACAO}\n\n${NOME}`, "categoria antes do nome: pergunta o nome primeiro");
const h2 = await c4("Bruno", { nome: "Bruno", produto: "material hidráulico", generico: true, pergunta: "Quais materiais hidráulicos você precisa? Por exemplo: canos, conexões, registros." });
ok(h2.resposta === "Certo, Bruno! Quais materiais hidráulicos você precisa? Por exemplo: canos, conexões, registros.", "depois do nome: a pergunta pelos itens");

const c5 = novaConversa();
await c5("oi");
const inv = await c5("Ana, coisas pra obra", { nome: "Ana", produto: "coisas pra obra", generico: true, pergunta: "Quais? Quantos? Para quando?" });
ok(inv.resposta === "Certo, Ana! Quais itens você precisa? Pode listar os produtos.", "pergunta sugerida inválida (mais de uma pergunta): usa a pergunta fixa");

const c6 = novaConversa();
await c6("oi");
const fim = await c6("Ana, material de construção, 1 caminhão, entregar amanhã",
  { nome: "Ana", produto: "material de construção", quantidade: "1 caminhão", observacoes: "Entregar amanhã.", generico: true, pergunta: "Quais materiais você precisa? Por exemplo: cimento, areia, tijolos." });
ok(fim.status === "IA" && fim.resposta.startsWith("Certo, Ana! Quais materiais você precisa?"), "tudo preenchido mas produto é categoria: a pergunta pelos itens vem antes de encerrar");

logReal("\n== Vários itens desde o início ==");
const c7 = novaConversa();
await c7("oi");
const v1 = await c7("Ana, quero cimento e areia", { nome: "Ana", produto: "cimento e areia", varios: true });
ok(v1.resposta === `Certo, Ana! ${QTD_CADA}`, "\"cimento e areia\": quantidade de cada um numa pergunta só");

logReal("\n== Produto novo na resposta das observações ==");
const c8 = novaConversa();
await c8("oi");
await c8("Ana", { nome: "Ana" });
await c8("cimento", { nome: "Ana", produto: "cimento" });
await c8("10 sacos", { nome: "Ana", produto: "cimento", quantidade: "10 sacos" });
const o1 = await c8("ah, também 2 latas de tinta branca", { nome: "Ana", produto: "cimento; tinta branca", quantidade: "10 sacos de cimento; 2 latas de tinta" });
ok(o1.status === "HUMANO" && o1.resumo.produto === "cimento; tinta branca" && o1.resumo.observacoes === NI,
  `produto novo vai para produto/quantidade; observações ficam "Não informado" (não copia a mensagem): ${JSON.stringify(o1.resumo.observacoes)}`);
const c9 = novaConversa();
await c9("oi");
await c9("Ana", { nome: "Ana" });
await c9("cimento", { nome: "Ana", produto: "cimento" });
await c9("10 sacos", { nome: "Ana", produto: "cimento", quantidade: "10 sacos" });
const o2 = await c9("entregar de manhã", { nome: "Ana", produto: "cimento", quantidade: "10 sacos" });
ok(o2.resumo.observacoes === "entregar de manhã", "observação de verdade (sem produto): continua indo para observações como antes");

logReal("\n== Validação das etapas (mensagens uma a uma, sem agrupamento) ==");
const cb = novaConversa();
await cb("Oi");
const b1 = await cb("quero fazer um orçamento", { observacoes: "Cliente quer fazer um orçamento.", qtdAplicavel: false });
ok(b1.resposta === "E qual é o seu nome?" && b1.resumo.nome === NI && b1.resumo.observacoes === NI,
  "frase de pedido na etapa do nome: não vira nome nem observação; pergunta o nome de novo com outras palavras");
const b2 = await cb("Paulo Santos", { nome: "Paulo Santos", qtdAplicavel: false });
ok(b2.resposta === `Certo, Paulo! ${PRODUTO}` && b2.resumo.nome === "Paulo Santos" && b2.resumo.produto === NI, "nome aceito; produto continua vazio e é perguntado");
const b3 = await cb("Paulo Santos", { nome: "Paulo Santos", produto: "Paulo Santos" });
ok(b3.resumo.produto === NI && b3.resposta === "Me conta qual produto ou material você precisa? Pode ser também a marca ou o modelo.",
  "o nome do cliente nunca vira produto (nem pelo Claude, nem pelo fallback); pergunta o produto de novo");
const b4 = await cb("cimento", { nome: "Paulo Santos", produto: "cimento" });
ok(b4.resposta === QTD, "\"quantidade não se aplica\" dado sem produto não pulou a quantidade");
const cg = novaConversa();
await cg("oi");
const sa = await cg("boa tarde");
ok(sa.resposta === "E qual é o seu nome?" && sa.resumo.nome === NI, "saudação não vira nome");
const ci = novaConversa();
await ci("oi");
await ci("Ana", { nome: "Ana" });
const in1 = await ci("quero fazer um orçamento", { nome: "Ana", produto: "orçamento" });
ok(in1.resumo.produto === NI && in1.resposta === "Me conta qual produto ou material você precisa? Pode ser também a marca ou o modelo.",
  "intenção sem produto na etapa do produto: não vira produto (nem \"orçamento\" do Claude)");

logReal("\n== Produto na etapa do nome ==");
for (const [msg, saida] of [["materiais elétricos", {}], ["cimento", {}], ["tinta acrílica", {}], ["cimento", { nome: "Cimento" }]] as const) {
  const cp = novaConversa();
  await cp("oi");
  const r = await cp(msg, saida);
  ok(r.resumo.nome === NI && r.resumo.produto === msg && r.resposta === `Anotei ${msg}! E qual é o seu nome?`,
    `"${msg}"${"nome" in saida ? " (o Claude pôs como nome)" : ""}: não vira nome, vira produto; "Anotei ${msg}! E qual é o seu nome?"`);
}
const cq = novaConversa();
await cq("oi");
await cq("cimento");
const q2 = await cq("Paulo", { nome: "Paulo", produto: "cimento" });
ok(q2.resposta === `Certo, Paulo! ${QTD}` && q2.resumo.produto === "cimento", "depois do \"Anotei\": o nome chega e a triagem segue para a quantidade (produto guardado)");

logReal("\n== \"Certo, {nome}!\" só com nome confiável ==");
for (const [msg, esperado] of [["Paulo", "Certo, Paulo!"], ["Maria José", "Certo, Maria!"], ["seu João", "Certo, João!"], ["dona Ana Lúcia", "Certo, Ana!"]] as const) {
  const cn = novaConversa();
  await cn("oi");
  const r = await cn(msg);
  ok(r.resposta === `${esperado} ${PRODUTO}` && r.resumo.nome === msg, `"${msg}" → "${esperado}" seguido direto da pergunta`);
}
for (const [msg, saida] of [["Paulo (filho)", {}], ["Ana Paula ✨", {}], ["eu", { nome: "Zé 2" }]] as const) {
  const ca = novaConversa();
  await ca("oi");
  const r = await ca(msg, saida);
  ok(r.resposta === `Certo! ${PRODUTO}`, `resposta ambígua "${msg}"${"nome" in saida ? " (nome do Claude: Zé 2)" : ""}: "Certo!" sem nome`);
}
const cs = novaConversa();
await cs("oi");
await cs("Paulo");
const sem = await cs("cimento", { nome: "Paulo", produto: "cimento" });
ok(sem.resposta === QTD, "o nome não aparece nas mensagens seguintes");

logReal("\n== Classificação da Claude na etapa do nome ==");
// O SDK (jsonSchemaOutputFormat) passa o enum para a descrição; o código valida o valor (fora dos três = reserva).
const campoClassif = schema.properties.classificacao_resposta_nome;
ok(schema.required.includes("classificacao_resposta_nome") && campoClassif.anyOf?.[0]?.type === "string" && campoClassif.anyOf?.[1]?.type === "null" &&
   ["nome_pessoa", "produto", "outro"].every((v) => String(campoClassif.anyOf[0].description).includes(v)),
  "schema: classificacao_resposta_nome é texto (nome_pessoa | produto | outro) ou null");
ok(/classificacao_resposta_nome/.test(instrucoes) && /luva de pedreiro/.test(instrucoes) && /rejunte cinza/.test(instrucoes) && /Ferro Santos/.test(instrucoes) && /Rosa/.test(instrucoes),
  "prompt com exemplos (produto fora da lista e nome que parece palavra comum)");
for (const msg of ["luva de pedreiro", "rejunte cinza", "espaçador de cerâmica"]) {
  const cc = novaConversa();
  await cc("oi");
  const r = await cc(msg, { classificacao: "produto" });
  ok(r.resumo.nome === NI && r.resumo.produto === msg && r.resposta === `Anotei ${msg}! E qual é o seu nome?`, `"${msg}" (classificado como produto): vira produto e "Anotei ${msg}! E qual é o seu nome?"`);
}
const sl = novaConversa();
await sl("oi");
const semLista = await sl("luva de pedreiro");
ok(semLista.resumo.nome === "luva de pedreiro", "sem a classificação, \"luva de pedreiro\" (fora da lista) ainda passaria como nome: por isso a Claude decide");
for (const [msg, saida, esperado] of [
  ["Ferro Santos", { nome: "Ferro Santos", classificacao: "nome_pessoa" }, "Certo, Ferro!"],
  ["Ferro Santos", { classificacao: "nome_pessoa" }, "Certo, Ferro!"],
  ["Rosa", { nome: "Rosa", classificacao: "nome_pessoa" }, "Certo, Rosa!"],
  ["Ana Paula ✨", { nome: "Ana Paula ✨", classificacao: "nome_pessoa" }, "Certo!"],
] as const) {
  const cf = novaConversa();
  await cf("oi");
  const r = await cf(msg, saida);
  ok(r.resumo.nome === msg && r.resposta === `${esperado} ${PRODUTO}`, `"${msg}" (nome_pessoa${"nome" in saida ? "" : ", nome pelo fallback"}) → "${esperado}"`);
}
const co = novaConversa();
await co("oi");
const outro = await co("tudo certo por aí?", { nome: "Tudo", classificacao: "outro" });
ok(outro.resumo.nome === NI && outro.resumo.produto === NI && outro.resposta === "E qual é o seu nome?",
  "\"outro\": não vira nome (nem o que a Claude pôs) e o nome é perguntado de novo com outras palavras");
const cb2 = novaConversa();
await cb2("oi");
const errou = await cb2("boa tarde", { nome: "boa tarde", classificacao: "nome_pessoa" });
ok(errou.resumo.nome === NI, "saudação continua sem virar nome, mesmo se a Claude disser nome_pessoa (regra do fade15e)");
for (const [rotulo, valor] of [["ausente", undefined], ["inválido", "talvez"], ["null", null]] as const) {
  const cr = novaConversa();
  await cr("oi");
  const r = await cr("cimento", valor === undefined ? {} : { classificacao: valor });
  ok(r.resumo.nome === NI && r.resposta === "Anotei cimento! E qual é o seu nome?", `classificação ${rotulo}: a lista de reserva decide ("cimento" vira produto)`);
}

logReal("\n== Depois de um reinício ==");
const iaR = new IAClaude("ATD-00000E9999");
iaR.restaurar({ triagem: { etapaAtual: "produto", perguntasEtapa: 0, etapasPuladas: [], apresentacaoPendente: false, quantidadeNaoAplicavel: false },
  resumo: { nome: "Ana", telefone: "5500900001900", produto: "materiais elétricos", quantidade: NI, observacoes: NI }, historico: [], ultimaMensagemEm: Date.now() });
proximas = [{ nome: "Ana", produto: "materiais elétricos", generico: true, pergunta: ITENS_ELETRICOS }];
const rr = await iaR.responder("não sei", { telefone: "5500900001900", status: "IA", resumo: { nome: "Ana", telefone: "5500900001900", produto: "materiais elétricos", quantidade: NI, observacoes: NI } });
ok(rr.resposta === QTD, "a pergunta pelos itens já tinha sido feita antes do reinício: não repete");

await banco.encerrarBanco();
logReal(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(falhas ? 1 : 0);
