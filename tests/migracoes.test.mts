// Controle de migrations (src/migracoes.ts, npm run migrate): aplica só as que faltam, cada uma numa
// transação com o seu registro, idempotente, e aborta fora de atendimento/atendimento_teste.
// Banco de testes: o preparo já aplicou e registrou sql/001..; as migrations extras usadas aqui ficam
// numa pasta temporária (cópia de sql/ + arquivos de teste) e são desfeitas no fim.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const raiz = fileURLToPath(new URL("..", import.meta.url));

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; console.log(`${c ? "OK  " : "FAIL"} ${t}`); };

const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const { aplicarMigrationsPendentes, corpoDaMigration, listarMigrations } = await import(B + "/src/migracoes.ts");

const conexao = await banco.obterConexao();
const registradas = async () => (await banco.consultar("SELECT nome FROM migrations_aplicadas ORDER BY nome")).rows.map((r: { nome: string }) => r.nome);
const existeTabela = async (nome: string) => (await banco.consultar("SELECT to_regclass($1) IS NOT NULL AS e", [`public.${nome}`])).rows[0].e === true;

const reais = listarMigrations(join(raiz, "sql"));
console.log("== Estado depois do preparo ==");
ok(JSON.stringify(await registradas()) === JSON.stringify(reais), `migrations registradas = as de sql/ (${reais.join(", ")})`);

console.log("\n== Só as que faltam, em ordem, cada uma com o seu registro ==");
const pasta = mkdtempSync(join(tmpdir(), "migracoes-teste-"));
cpSync(join(raiz, "sql"), pasta, { recursive: true });
writeFileSync(join(pasta, "905_teste_a.sql"), "BEGIN;\nCREATE TABLE teste_migracao_a (id int);\nCOMMIT;\n");
writeFileSync(join(pasta, "906_teste_b.sql"), "BEGIN;\nCREATE TABLE teste_migracao_b (id int);\nINSERT INTO teste_migracao_b VALUES (1);\nCOMMIT;\n");
const r1 = await aplicarMigrationsPendentes(conexao, pasta);
ok(JSON.stringify(r1.aplicadas) === JSON.stringify(["905_teste_a.sql", "906_teste_b.sql"]) && r1.jaAplicadas === reais.length,
  `aplicou só as 2 novas, em ordem (${r1.aplicadas.join(", ")}); ${r1.jaAplicadas} já estavam`);
ok((await existeTabela("teste_migracao_a")) && (await existeTabela("teste_migracao_b")) && (await registradas()).includes("906_teste_b.sql"), "tabelas criadas e registradas");
const r2 = await aplicarMigrationsPendentes(conexao, pasta);
ok(r2.aplicadas.length === 0, "segunda execução: nada a aplicar (idempotente)");

console.log("\n== Migration com erro: nada dela entra ==");
writeFileSync(join(pasta, "907_teste_erro.sql"), "BEGIN;\nCREATE TABLE teste_migracao_c (id int);\nINSERT INTO tabela_que_nao_existe VALUES (1);\nCOMMIT;\n");
let erro = "";
try { await aplicarMigrationsPendentes(conexao, pasta); } catch (e) { erro = e instanceof Error ? e.message : String(e); }
ok(erro === "907_teste_erro.sql: falhou (42P01); nada desta migration foi aplicado." && !(await existeTabela("teste_migracao_c")) && !(await registradas()).includes("907_teste_erro.sql"),
  `erro relatado com o código; tabela da migration com erro não criada; sem registro (${erro})`);
rmSync(join(pasta, "907_teste_erro.sql"));

console.log("\n== Proteções ==");
ok((() => { try { corpoDaMigration("x.sql", "CREATE TABLE y (id int);"); return false; } catch { return true; } })(), "migration sem BEGIN;/COMMIT; em linhas próprias é recusada");
const comandos: string[] = [];
const simulado = { query: async (texto: string) => { comandos.push(texto); return { rows: [{ db: "outro_sistema" }] }; } };
let erroBanco = "";
try { await aplicarMigrationsPendentes(simulado, pasta); } catch (e) { erroBanco = e instanceof Error ? e.message : String(e); }
ok(erroBanco.startsWith("ABORTADO: migrations só em atendimento ou atendimento_teste") && comandos.length === 1, "outro banco (outro_sistema, simulado): aborta depois só do SELECT current_database()");
const salvas = await registradas();
await banco.consultar("DELETE FROM migrations_aplicadas");
let erroVazio = "";
try { await aplicarMigrationsPendentes(conexao, pasta); } catch (e) { erroVazio = e instanceof Error ? e.message : String(e); }
ok(erroVazio.includes("já tem tabelas, mas migrations_aplicadas está vazia") && (await registradas()).length === 0, "banco com tabelas e controle vazio: aborta sem reaplicar a 001");
for (const nome of salvas) await banco.consultar("INSERT INTO migrations_aplicadas (nome) VALUES ($1)", [nome]);

console.log("\n== npm run migrate (processo, banco de testes) ==");
const cmd = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrar.mts"], { cwd: raiz, encoding: "utf8", timeout: 60_000 });
ok(cmd.status === 0 && cmd.stdout.includes(`[migrate] atendimento_teste: nada a aplicar (${salvas.length} já aplicadas).`), `script: ${cmd.stdout.trim()}`);
const senha = process.env.DB_PASSWORD ?? "";
ok(!senha || !(cmd.stdout + cmd.stderr).includes(senha), "nenhuma senha na saída");

console.log("\n== Limpeza ==");
await banco.consultar("DROP TABLE IF EXISTS teste_migracao_a, teste_migracao_b, teste_migracao_c");
await banco.consultar("DELETE FROM migrations_aplicadas WHERE nome LIKE '9__\\_teste\\_%'");
rmSync(pasta, { recursive: true, force: true });
ok(JSON.stringify(await registradas()) === JSON.stringify(reais) && !(await existeTabela("teste_migracao_a")), "banco de testes de volta ao estado do preparo");
conexao.release();
await banco.encerrarBanco();

console.log(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
