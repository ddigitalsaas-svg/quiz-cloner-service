# Deploy no Render.com (gratuito)

## 1. Criar conta
https://render.com — crie uma conta gratuita

## 2. Novo Web Service
- Dashboard → "New" → "Web Service"
- Conecte seu GitHub e suba a pasta `quiz-cloner-service`
- Ou use "Public Git Repo" se preferir

## 3. Configurações
- **Name:** quiz-cloner-service
- **Runtime:** Node
- **Build Command:** npm install
- **Start Command:** node server.js
- **Plan:** Free

## 4. Variáveis de ambiente
- `SECRET_TOKEN` → crie uma senha forte (ex: gere com `openssl rand -hex 32`)
- `NODE_ENV` → production

## 5. Após o deploy
Copie a URL do serviço (ex: https://quiz-cloner-service.onrender.com)

## 6. Configurar no Supabase
No painel do Supabase → Edge Functions → Secrets:
- `CLONER_SERVICE_URL` = https://quiz-cloner-service.onrender.com
- `CLONER_SECRET_TOKEN` = (o mesmo SECRET_TOKEN do Render)
- `ANTHROPIC_API_KEY` = sk-ant-... (sua chave da Anthropic)

## 7. Deploy da Edge Function
```bash
supabase functions deploy import-quiz
```

## Observação sobre o Free Tier
O serviço "dorme" após 15 min sem uso.
Na primeira clonagem do dia pode demorar ~30 segundos para acordar.
Isso é normal e aceitável para uma feature de clonagem que não é usada constantemente.
Para produção com muitos usuários, upgrade para o plano Starter ($7/mês) do Render.
