// B7: áudio, imagem e outras mídias do cliente. Servidor real + banco de testes (atendimento_teste).
// Chats "meta:999:55009000016xx", wamids "teste-midia-...". Claude, Telegram e Graph API simulados;
// rede externa bloqueada.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39888",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-midia",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39888";
const GRUPO = "-1009999999999";

// Relógio controlado: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
let desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;
const MIN = 60_000;

// Graph API simulada: guarda o que cada cliente recebeu; graphAceita = false recusa (erro permanente).
const enviados: { to: string; texto: string }[] = [];
let graphAceita = true;
let resp = 0;
const telegram: { metodo: string; corpo: any }[] = [];
const fetchReal = globalThis.fetch;
const externas: string[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    const corpo = JSON.parse(init.body);
    if (!graphAceita) {
      return new Response(JSON.stringify({ error: { code: 131047, message: "recusado (simulado)" } }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    enviados.push({ to: corpo.to, texto: corpo.text?.body ?? "" });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-midia-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    telegram.push({ metodo: m[1]!, corpo: JSON.parse(init.body) });
    return { status: 200, json: async () => ({ ok: true, result: m[1] === "sendMessage" ? { message_id: 1 } : true }) } as any;
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

// Claude simulado: nunca preenche campos (a triagem usa o texto do cliente); guarda o histórico recebido.
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
const chamadasClaude: any[][] = [];
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  chamadasClaude.push(params.messages);
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const webhook = await import(B + "/src/webhook.ts");
const ia = await import(B + "/src/iaClaude.ts");
const { MENSAGEM_LOJA_FECHADA } = await import(B + "/src/horarioFuncionamento.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
await webhook.iniciarWebhook();

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms = 500) => new Promise((r) => setTimeout(r, ms));
const chat = (tel: string) => `meta:999:${tel}`;
const TEL = (n: number) => `55009000016${String(n).padStart(2, "0")}`;
const APRESENTACAO = "Olá! Seja bem-vindo(a) à loja Exemplo Materiais de Construção! Sou a assistente virtual e vou dar início ao seu atendimento.";
const PERGUNTA_NOME = "Para começarmos, qual é o seu nome?";
const HUMANO = "Perfeito! Vou encaminhar seu atendimento para um vendedor da loja, que dará continuidade.";

type Item = { texto: string } | { tipo: string; legenda?: string };
let seq = 0;
// Um POST com os itens na ordem (lote de messages[]).
async function enviar(tel: string, itens: Item[]) {
  const messages = itens.map((item) => {
    const base = { id: `teste-midia-${++seq}`, from: tel, timestamp: String(Math.floor(Date.now() / 1000)) };
    if ("texto" in item) return { ...base, type: "text", text: { body: item.texto } };
    const conteudo: Record<string, unknown> = item.tipo === "location" ? { latitude: -1.4, longitude: -48.5 } : { id: `midia-${seq}`, mime_type: "x/y" };
    if (item.legenda !== undefined) conteudo.caption = item.legenda;
    return { ...base, type: item.tipo, [item.tipo]: item.tipo === "contacts" ? [{ name: { formatted_name: "x" } }] : conteudo };
  });
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" }, messages } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  const r = await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera(400 + 150 * itens.length);
  return r.status;
}
const recebeu = (tel: string) => enviados.filter((e) => e.to === tel).map((e) => e.texto);
const status = async (tel: string) => (await banco.consultar("SELECT status FROM atendimentos WHERE chat_id = $1 ORDER BY id DESC LIMIT 1", [chat(tel)])).rows[0]?.status;
const mensagensNoBanco = async (tel: string) => (await banco.consultar(
  `SELECT m.direcao, m.texto FROM mensagens m JOIN atendimentos a ON a.id = m.atendimento_id WHERE a.chat_id = $1 ORDER BY m.criado_em, m.id`, [chat(tel)])).rows as { direcao: string; texto: string }[];
// Só os resumos (o grupo também recebe as mensagens repassadas, "📩 ...").
const doGrupo = () => telegram.filter((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === GRUPO).map((c) => String(c.corpo.text));
const resumosNoGrupo = () => doGrupo().filter((t) => t.includes("📋 NOVO ATENDIMENTO"));

const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

out("== Imagem como 1ª mensagem ==");
const c0 = chamadasClaude.length;
await enviar(TEL(1), [{ tipo: "image" }]);
ok(JSON.stringify(recebeu(TEL(1))) === JSON.stringify([`${APRESENTACAO}\n\n${ia.AVISO_MIDIA_INICIO}`]), "apresentação + aviso de mídia, numa mensagem só");
ok(!recebeu(TEL(1))[0]!.includes("nome") && chamadasClaude.length === c0, "sem pergunta do nome; Claude não chamado");
ok(webhook.lerEstadoEspelhavel(chat(TEL(1)))?.triagem.etapaAtual === null && (await status(TEL(1))) === "IA", "triagem não começou (sem etapa); status IA");
await enviar(TEL(1), [{ texto: "oi, preciso de cimento" }]);
ok(recebeu(TEL(1))[1] === PERGUNTA_NOME && chamadasClaude.length === c0 + 1, "texto depois: a triagem pede o nome (sem repetir a apresentação)");

out("\n== \"Olá\" + imagem com legenda no mesmo lote ==");
const c1 = chamadasClaude.length;
await enviar(TEL(2), [{ texto: "Olá" }, { tipo: "image", legenda: "vcs tem isso?" }]);
ok(JSON.stringify(recebeu(TEL(2))) === JSON.stringify([`${APRESENTACAO}\n\n${PERGUNTA_NOME}`, ia.AVISO_MIDIA_COM_LEGENDA]), "primeiro apresentação + nome, depois o aviso (c)");
ok(chamadasClaude.length === c1 + 1, "Claude chamado só pelo \"Olá\" (a legenda sozinha não chama)");
const m2 = await mensagensNoBanco(TEL(2));
ok(m2.map((m) => (m.direcao === "ENTRADA" ? "E" : "S")).join("") === "ESES" && m2[2]?.texto === "[enviou imagem com a legenda]: vcs tem isso?",
  "espelho: a legenda gravada como mensagem do cliente, marcada; o aviso como saída");
ok(webhook.lerEstadoEspelhavel(chat(TEL(2)))?.triagem.etapaAtual === "nome", "a etapa (nome) não mudou com o aviso");
await enviar(TEL(2), [{ texto: "Ana" }]);
const historico = JSON.stringify(chamadasClaude.at(-1));
ok(chamadasClaude.length === c1 + 2 && historico.includes("[enviou imagem com a legenda]: vcs tem isso?") && historico.includes(ia.AVISO_MIDIA_COM_LEGENDA),
  "texto seguinte: o Claude recebe a legenda e o aviso no histórico");

out("\n== Mídia de novo depois do aviso → HUMANO ==");
desloc += 31_000;
const grupo0 = resumosNoGrupo().length;
await enviar(TEL(2), [{ tipo: "audio" }]);
const resumo2 = resumosNoGrupo().slice(grupo0);
ok(recebeu(TEL(2)).at(-1) === HUMANO && (await status(TEL(2))) === "HUMANO", "resposta de encaminhamento; atendimento HUMANO");
ok(resumo2.length === 1 && resumo2[0]!.includes("Cliente enviou áudio/imagem.") && resumo2[0]!.includes('Cliente enviou imagem com a legenda: "vcs tem isso?".'),
  "resumo no grupo com a observação e a legenda");
const antesHumano = recebeu(TEL(2)).length;
const repasses0 = doGrupo().filter((t) => t.startsWith("📩")).length;
await enviar(TEL(2), [{ tipo: "image" }, { texto: "alô?" }]);
// Mídia sem legenda depois do encaminhamento: nada; o texto seguinte ("alô?") recebe o aviso único e vai ao grupo.
const repassados2 = doGrupo().filter((t) => t.startsWith("📩")).slice(repasses0);
ok(recebeu(TEL(2)).length === antesHumano + 1 && recebeu(TEL(2)).at(-1)!.startsWith("Seu pedido já está com a nossa equipe de vendas") && resumosNoGrupo().length === grupo0 + 1,
  "imagem e \"alô?\" em HUMANO: só o aviso único (por causa do texto), sem IA, sem novo resumo");
ok(repassados2.length === 1 && repassados2[0]!.endsWith('escreveu: "alô?"'), "só o texto é repassado ao grupo; a imagem sem legenda não");
await enviar(TEL(2), [{ tipo: "image" }]);
ok(recebeu(TEL(2)).length === antesHumano + 1, "mais mídia em HUMANO: nada");

out("\n== Várias mídias = um aviso ==");
await enviar(TEL(3), [{ texto: "Olá" }]);
await enviar(TEL(3), [{ tipo: "image" }, { tipo: "image" }, { tipo: "image" }]);
ok(JSON.stringify(recebeu(TEL(3)).slice(1)) === JSON.stringify([ia.AVISO_MIDIA_SEM_LEGENDA]), "3 fotos no mesmo lote: um aviso só (b)");
desloc += 5_000;
await enviar(TEL(3), [{ tipo: "image" }]);
desloc += 5_000;
await enviar(TEL(3), [{ tipo: "video", legenda: "esse aqui" }]);
ok(recebeu(TEL(3)).length === 2 && (await status(TEL(3))) === "IA", "mais mídias em requisições separadas dentro de 30 s: mesmo envio, sem resposta, segue IA");
ok((await mensagensNoBanco(TEL(3))).filter((m) => m.direcao === "ENTRADA").length === 6, "todas as mídias gravadas como entrada no espelho");

out("\n== Outros tipos de mídia ==");
for (const [n, tipo] of [[4, "document"], [5, "sticker"], [6, "location"], [7, "contacts"], [8, "video"]] as const) {
  await enviar(TEL(n), [{ tipo }]);
  ok(recebeu(TEL(n))[0] === `${APRESENTACAO}\n\n${ia.AVISO_MIDIA_INICIO}`, `${tipo}: apresentação + aviso`);
}
await enviar(TEL(9), [{ tipo: "reaction" }]);
ok(recebeu(TEL(9)).length === 0 && webhook.lerEstadoEspelhavel(chat(TEL(9))) === null, "reação (tipo fora da lista): ignorada como hoje");

out("\n== Mídia não encerra por inatividade ==");
await enviar(TEL(10), [{ texto: "Olá" }]);
desloc += 15 * MIN;
await enviar(TEL(10), [{ tipo: "audio" }]);
desloc += 2 * MIN; // 17 min depois do texto, 2 min depois do áudio
webhook.verificarInatividade();
ok(webhook.lerEstadoEspelhavel(chat(TEL(10)))?.status === "IA", "áudio conta como atividade: conversa continua aberta");
// Mídia sem continuação (nada escrito depois do aviso): 3 min depois vai ao vendedor, não encerra.
const grupo10 = resumosNoGrupo().length;
desloc += 1 * MIN + 5_000;
webhook.verificarInatividade();
await espera(700);
ok(webhook.lerEstadoEspelhavel(chat(TEL(10)))?.status === "HUMANO" && resumosNoGrupo().slice(grupo10).some((t) => t.includes("Cliente enviou áudio sem texto.")),
  "3 min depois do áudio sem continuação: vai ao vendedor (\"Cliente enviou áudio sem texto.\")");

out("\n== Aviso não entregue: mesmas regras de qualquer resposta ==");
graphAceita = false;
const grupo1 = resumosNoGrupo().length;
await enviar(TEL(11), [{ tipo: "image", legenda: "tem esse piso?" }]);
graphAceita = true;
// (As conversas só com mídia de antes também vão ao vendedor: conta só a deste cliente.)
const resumo11 = resumosNoGrupo().slice(grupo1).filter((t) => t.includes("tem esse piso?"));
ok((await status(TEL(11))) === "HUMANO" && resumo11.length === 1 && resumo11[0]!.startsWith("⚠️") && resumo11[0]!.includes('Cliente enviou imagem com a legenda: "tem esse piso?".'),
  "falha no envio do aviso: HUMANO e resumo com o aviso ⚠️ (legenda nas observações)");

out("\n== Loja fechada ==");
const desloc0 = desloc;
desloc = Date.parse("2026-10-07T22:00:00-03:00") - agoraReal();
await enviar(TEL(12), [{ tipo: "image", legenda: "preço?" }]);
ok(JSON.stringify(recebeu(TEL(12))) === JSON.stringify([MENSAGEM_LOJA_FECHADA]) && webhook.lerEstadoEspelhavel(chat(TEL(12))) === null,
  "mídia com a loja fechada: mensagem de loja fechada, sem atendimento");
desloc = desloc0;

out("\n== \"sim\" ao vendedor oferecido no aviso ==");
const PEDIU_HUMANO = "Cliente pediu para falar com um atendente.";
for (const [n, resposta] of [[20, "sim"], [21, "Pode passar!"], [26, "  Por favor.  "], [27, "VENDEDOR"]] as const) {
  await enviar(TEL(n), [{ tipo: "image" }]);
  const cS = chamadasClaude.length, gS = resumosNoGrupo().length;
  await enviar(TEL(n), [{ texto: resposta }]);
  const resumoS = resumosNoGrupo().slice(gS);
  ok(recebeu(TEL(n)).at(-1) === HUMANO && (await status(TEL(n))) === "HUMANO" && chamadasClaude.length === cS,
    `aviso → "${resposta}": HUMANO com a resposta de encaminhamento, sem chamar o Claude`);
  ok(resumoS.length === 1 && resumoS[0]!.includes(PEDIU_HUMANO), `aviso → "${resposta}": resumo com "${PEDIU_HUMANO}"`);
}
await enviar(TEL(22), [{ tipo: "audio" }]);
await enviar(TEL(22), [{ texto: "ok" }]);
ok(recebeu(TEL(22)).at(-1) === PERGUNTA_NOME && (await status(TEL(22))) === "IA", "aviso → \"ok\": triagem normal (pede o nome)");
await enviar(TEL(23), [{ tipo: "image" }]);
const c23 = chamadasClaude.length;
await enviar(TEL(23), [{ texto: "sim, é um cimento" }]);
ok(recebeu(TEL(23)).at(-1) === PERGUNTA_NOME && (await status(TEL(23))) === "IA" && chamadasClaude.length === c23 + 1,
  "aviso → \"sim, é um cimento\": frase, não resposta curta (triagem normal, com o Claude)");
await enviar(TEL(24), [{ texto: "sim" }]);
ok(recebeu(TEL(24)).at(-1) === `${APRESENTACAO}\n\n${PERGUNTA_NOME}` && (await status(TEL(24))) === "IA", "\"sim\" sem aviso de mídia antes: triagem normal");
await enviar(TEL(25), [{ tipo: "image" }]);
await enviar(TEL(25), [{ texto: "oi" }]);
await enviar(TEL(25), [{ texto: "sim" }]);
ok((await status(TEL(25))) === "IA" && recebeu(TEL(25)).at(-1) !== HUMANO, "aviso → texto → \"sim\": só a 1ª mensagem conta (triagem normal)");
await enviar(TEL(28), [{ tipo: "image" }]);
desloc += 5_000;
await enviar(TEL(28), [{ tipo: "image" }]);
await enviar(TEL(28), [{ texto: "s" }]);
ok((await status(TEL(28))) === "HUMANO", "aviso → foto do mesmo envio → \"s\": ainda é a 1ª mensagem de texto (HUMANO)");

// Reinício simulado como na suíte de recuperação: memória zerada + recuperação do banco.
async function reiniciar() {
  webhook.redefinirEstadoWebhookParaTestes();
  const r = await webhook.recuperarNaPartida();
  await espera(300);
  return r.ok;
}
await enviar(TEL(29), [{ tipo: "image" }]);
ok(await reiniciar(), "reinício depois do aviso: recuperação do banco");
const c29 = chamadasClaude.length, g29 = resumosNoGrupo().length;
await enviar(TEL(29), [{ texto: "sim" }]);
const resumo29 = resumosNoGrupo().slice(g29);
ok(recebeu(TEL(29)).at(-1) === HUMANO && (await status(TEL(29))) === "HUMANO" && chamadasClaude.length === c29 &&
   resumo29.length === 1 && resumo29[0]!.includes(PEDIU_HUMANO),
  "aviso → reinício → \"sim\": HUMANO com a observação, sem chamar o Claude");
await enviar(TEL(30), [{ tipo: "image" }]);
await enviar(TEL(30), [{ texto: "oi" }]);
ok(await reiniciar(), "reinício depois de aviso → \"oi\": recuperação do banco");
await enviar(TEL(30), [{ texto: "sim" }]);
ok((await status(TEL(30))) === "IA" && recebeu(TEL(30)).at(-1) !== HUMANO, "aviso → \"oi\" → reinício → \"sim\": triagem normal (a 1ª mensagem já tinha vindo)");

out("\n== Logs ==");
ok(logs.some((l) => l.includes("mídia: image | legenda: sim")) && logs.some((l) => /Atendimento ATD-[0-9A-F]{10}: mídia image \(legenda: sim\) \| aviso de mídia/.test(l)),
  "log com o tipo, se tinha legenda e o código do atendimento");
ok(!logs.some((l) => ["vcs tem isso?", "esse aqui", "tem esse piso?", "preço?", "midia-"].some((t) => l.includes(t))), "nenhum log com legenda ou id de mídia");
ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-midia-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
ok(espelho.restantes === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes; restantes = ${espelho.restantes}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
