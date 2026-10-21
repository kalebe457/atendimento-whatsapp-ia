// B9: desligamento ordenado. O backend roda num processo filho (tests/processo-backend-teste.mts), com Meta,
// Telegram e Claude simulados e banco de testes (atendimento_teste). No Windows o pai não consegue mandar SIGTERM
// de verdade (kill = TerminateProcess), então o filho recebe "SIGTERM" pela stdin e faz process.emit("SIGTERM"):
// o mesmo tratador que o systemd aciona em produção.
// Chats "meta:999:<telefone fictício 55009000015xx>", wamids "teste-desl-...".
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

const PORTA = 39887;
const BASE = `http://127.0.0.1:${PORTA}`;
const raiz = fileURLToPath(new URL("..", import.meta.url));
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");

// O mesmo relógio para o pai e os filhos: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
const desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

const out = console.log.bind(console);
let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

type Evento = { tipo: string; dado: string; filho: number; em: number };
const eventos: Evento[] = [];
let nFilho = 0;
const filhos: ChildProcess[] = [];

function subir(extra: Record<string, string> = {}) {
  const id = ++nFilho;
  const filho = spawn(process.execPath, ["--import", "tsx", "tests/processo-backend-teste.mts"], {
    cwd: raiz,
    env: { ...process.env, PORT: String(PORTA), TESTE_DESLOC_MS: String(desloc), TESTE_MSG_ID_INICIAL: String(id * 1000), TESTE_SINAL_STDIN: "1", ...extra },
    stdio: ["pipe", "pipe", "pipe"],
  });
  filhos.push(filho);
  let resto = "";
  filho.stdout!.on("data", (bloco: Buffer) => {
    resto += bloco.toString("utf8");
    const linhas = resto.split("\n");
    resto = linhas.pop() ?? "";
    for (const linha of linhas) {
      const m = /^@@(\w+) (.*)$/.exec(linha);
      if (m) eventos.push({ tipo: m[1]!, dado: m[2]!, filho: id, em: agoraReal() });
    }
  });
  filho.stderr!.on("data", () => undefined);
  const saida = new Promise<{ codigo: number | null; em: number }>((r) => filho.once("exit", (codigo) => r({ codigo, em: agoraReal() })));
  return { filho, id, saida };
}
async function aguardar(cond: () => boolean, ms: number) {
  for (const fim = agoraReal() + ms; agoraReal() < fim; await espera(50)) if (cond()) return true;
  return cond();
}
const logsDo = (id: number) => eventos.filter((e) => e.filho === id && e.tipo === "LOG").map((e) => e.dado);
const temLog = (id: number, trecho: string) => logsDo(id).some((l) => l.includes(trecho));
const doTipo = (id: number, tipo: string) => eventos.filter((e) => e.filho === id && e.tipo === tipo);
const sinal = (filho: ChildProcess) => filho.stdin!.write("SIGTERM\n");

let seq = 0;
function corpoMeta(tel: string, texto: string) {
  const wamid = `teste-desl-${++seq}`;
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: wamid, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  return { wamid, corpo, sig: "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex") };
}
async function postar(c: { corpo: string; sig: string }): Promise<number | string> {
  try {
    const r = await fetch(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": c.sig }, body: c.corpo });
    return r.status;
  } catch (erro: any) {
    return erro?.cause?.code ?? "erro";
  }
}
const chat = (tel: string) => `meta:999:${tel}`;
const evento = async (wamid: string) => Number((await banco.consultar("SELECT count(*) n FROM eventos_processados WHERE mensagem_externa_id = $1", [wamid])).rows[0].n);
const direcoes = async (tel: string) => (await banco.consultar(
  `SELECT m.direcao FROM mensagens m JOIN atendimentos a ON a.id = m.atendimento_id WHERE a.chat_id = $1 ORDER BY m.criado_em, m.id`, [chat(tel)])).rows
  .map((r: { direcao: string }) => (r.direcao === "ENTRADA" ? "E" : "S")).join("");

out("== SIGTERM com uma mensagem no meio do processamento ==");
const TEL_A = "5500900001501", TEL_B = "5500900001502", TEL_C = "5500900001503";
const p1 = subir({ TESTE_CLAUDE_ATRASO_MS: "2500" });
ok(await aguardar(() => temLog(p1.id, "Backend ouvindo"), 30_000), "1º processo ouvindo");
const mA = corpoMeta(TEL_A, "oi");
ok((await postar(mA)) === 200 && (await aguardar(() => doTipo(p1.id, "CLAUDE").length > 0, 5_000)), "mensagem do cliente A aceita; Claude respondendo (2,5 s)");
const graphAntes = doTipo(p1.id, "GRAPH").length;
sinal(p1.filho);
ok(await aguardar(() => temLog(p1.id, "[Desligamento] SIGTERM recebido"), 3_000), "SIGTERM recebido: desligamento começou");
const mB = corpoMeta(TEL_B, "oi");
const stB = await postar(mB);
const stTg = await fetch(BASE + "/telegram/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "falso" },
  body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 990000000601, type: "private" }, from: { id: 990000000601, first_name: "Teste" }, text: "/start" } }) })
  .then((r) => r.status, () => "erro");
const stHealth = await fetch(BASE + "/health").then((r) => r.status, () => "erro");
ok(stB === 503 && stTg === 503 && stHealth === 503, `durante o desligamento: Meta ${stB}, Telegram ${stTg}, health ${stHealth} (503 para reenviarem)`);
ok((await evento(mB.wamid)) === 0, "mensagem recusada NÃO foi registrada em eventos_processados (o reenvio da Meta não vira duplicada)");
const s1 = await Promise.race([p1.saida, espera(20_000).then(() => null)]);
ok(s1?.codigo === 0, `saiu sozinho com código 0 (${s1?.codigo ?? "não saiu"})`);
ok(doTipo(p1.id, "GRAPH").length === graphAntes + 1, "a resposta ao cliente A saiu antes de encerrar (fila concluída)");
ok((await direcoes(TEL_A)) === "ES", `mensagens de A gravadas no banco (entrada e saída): "${await direcoes(TEL_A)}"`);
const l1 = logsDo(p1.id);
const iConcluido = l1.findIndex((l) => l.includes("[Desligamento] trabalho em andamento concluído")), iBanco = l1.findIndex((l) => l.includes("[Desligamento] banco fechado; saindo"));
ok(iConcluido >= 0 && iBanco > iConcluido, "ordem: fila concluída → banco fechado → saída");

out("\n== Reenvio da Meta depois de subir de novo ==");
const p2 = subir();
ok(await aguardar(() => temLog(p2.id, "Backend ouvindo"), 30_000), "2º processo ouvindo");
ok((await postar(mB)) === 200 && (await aguardar(() => doTipo(p2.id, "GRAPH").length > 0, 5_000)), "a mesma mensagem de B, reenviada, é processada normalmente");
sinal(p2.filho);
const s2 = await Promise.race([p2.saida, espera(20_000).then(() => null)]);
ok(s2?.codigo === 0 && !temLog(p2.id, "ATENÇÃO: limite"), "sem trabalho em andamento: sai na hora, código 0");

out("\n== Limite estourado ==");
const p3 = subir({ TESTE_CLAUDE_ATRASO_MS: "20000", TESTE_LIMITE_DESLIGAMENTO_MS: "1500" });
ok(await aguardar(() => temLog(p3.id, "Backend ouvindo"), 30_000), "3º processo ouvindo (limite de 1,5 s, Claude demorando 20 s)");
ok((await postar(corpoMeta(TEL_C, "oi"))) === 200 && (await aguardar(() => doTipo(p3.id, "CLAUDE").length > 0, 5_000)), "mensagem de C aceita; Claude respondendo");
const t3 = agoraReal();
sinal(p3.filho);
const s3 = await Promise.race([p3.saida, espera(20_000).then(() => null)]);
const dt3 = (s3?.em ?? agoraReal()) - t3;
ok(s3?.codigo === 0 && dt3 >= 1_400 && dt3 < 8_000, `saiu no limite (${(dt3 / 1000).toFixed(1)} s, código ${s3?.codigo ?? "não saiu"})`);
ok(temLog(p3.id, "[Desligamento] ATENÇÃO: limite de 1.5 s atingido com 1 conversa(s)"), "log em destaque com o que ficou em andamento");

out("\n== Segundo sinal sai na hora ==");
const p4 = subir({ TESTE_CLAUDE_ATRASO_MS: "20000" });
ok(await aguardar(() => temLog(p4.id, "Backend ouvindo"), 30_000), "4º processo ouvindo");
await postar(corpoMeta(TEL_C, "Ana"));
await aguardar(() => doTipo(p4.id, "CLAUDE").length > 0, 5_000);
sinal(p4.filho);
await aguardar(() => temLog(p4.id, "[Desligamento] SIGTERM recebido"), 3_000);
sinal(p4.filho);
const s4 = await Promise.race([p4.saida, espera(10_000).then(() => null)]);
ok(s4?.codigo === 1 && temLog(p4.id, "[Desligamento] SIGTERM de novo: saindo agora."), `segundo SIGTERM: sai na hora (código ${s4?.codigo ?? "não saiu"})`);

const vazou = eventos.filter((e) => e.tipo === "LOG" && [TEL_A, TEL_B, TEL_C].some((t) => e.dado.includes(t)));
ok(vazou.length === 0, "nenhum log com telefone completo");

out("\n== Limpeza ==");
for (const f of filhos) if (f.exitCode === null && f.signalCode === null) { f.kill("SIGKILL"); await new Promise((r) => f.once("exit", r)); }
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-desl-%' OR mensagem_externa_id LIKE 'wamid.teste-5d-filho-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
ok(espelho.restantes === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes; restantes = ${espelho.restantes}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
process.exit(falhas ? 1 : 0);
