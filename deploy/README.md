# Kit de deploy (exemplo)

Arquivos para rodar o backend numa VPS Linux (testado em Ubuntu 24.04). Todos os nomes, domínios e
caminhos são genéricos (`exemplo.com.br`, usuário/serviço `atendimento`, pasta `/opt/app`).

| Arquivo | Para quê |
|---|---|
| `atendimento.service` | Unit do systemd: `node dist/mainwebhook.js`, só em `127.0.0.1`, desligamento ordenado (`TimeoutStopSec=60`), endurecimento (`NoNewPrivileges`, sistema de arquivos só leitura) e `OnFailure=` para avisar os administradores. |
| `atendimento-alerta@.service` | Chamado pelo `OnFailure=`: avisa os administradores do grupo no Telegram (`src/alertarAdmins.ts`). |
| `Caddyfile` | HTTPS automático; na API só `/meta/webhook`, `/telegram/webhook` e `/health` chegam ao backend; a raiz serve `deploy/site/`. |
| `journald-atendimento.conf` | Retenção dos logs (30 dias). |
| `atualizar.sh` | Atualização: pull, `npm ci`, build, migrations, site, restart e `/health` (para no primeiro erro). |
| `backup/` | `pg_dump` diário com retenção local, restauração e (opcional) cópia criptografada externa. |
| `site/` | Página estática de exemplo e modelo de política de privacidade. |

## Passos (resumo)

1. Usuário do sistema `atendimento`, Node.js LTS, PostgreSQL, Caddy e ufw (22/80/443).
2. Código em `/opt/app/backend`; `.env` criado à mão a partir do `.env.example` (dono `atendimento`, permissão 600).
3. Banco: papel do app sem DDL (`sql/papeis/atendimento_app.sql`); `npm run migrate` com o dono do banco.
4. `npm ci && npm run build`; instalar a unit, o Caddyfile e o journald; `systemctl enable --now atendimento`.
5. Configurar os webhooks: Meta → `https://api.exemplo.com.br/meta/webhook`; Telegram (`setWebhook`
   com `secret_token`) → `https://api.exemplo.com.br/telegram/webhook`.
6. Conferir: `curl https://api.exemplo.com.br/health` e `journalctl -u atendimento -f`.
