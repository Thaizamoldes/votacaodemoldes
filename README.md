# Votação de Moldes — Thaiza Gonçalves

Site de votação de novos moldes, com login, envio de até 5 fotos por aluna e votação entre todas.

## ✅ O que você precisa fazer (passo a passo)

### Parte 1 — Criar o banco de dados gratuito (Firebase)

1. Acesse **https://console.firebase.google.com** e entre com sua conta Google.
2. Clique em **"Adicionar projeto"**, dê um nome (ex: `votacao-moldes`) e siga os passos (pode desativar o Google Analytics, não precisa).
3. Dentro do projeto, no menu lateral, vá em **Build > Authentication** → clique em **"Get started"** → na aba **Sign-in method**, ative o provedor **"E-mail/senha"**.
4. Vá em **Build > Firestore Database** → **"Criar banco de dados"** → escolha o modo **produção** → escolha a localização (ex: `southamerica-east1` para Brasil) → criar.
   - Depois de criado, vá na aba **Regras** e cole isto (permite leitura para todos logados, escrita controlada):
     ```
     rules_version = '2';
     service cloud.firestore {
       match /databases/{database}/documents {
         match /{document=**} {
           allow read: if request.auth != null;
           allow write: if request.auth != null;
         }
       }
     }
     ```
   - Clique em **Publicar**.
5. Volte para a página inicial do projeto (ícone de casa) → clique no ícone **`</>`** (Web) para criar um "app da Web" → dê um nome (ex: `site-votacao`) → **não** precisa marcar Firebase Hosting → **Registrar app**.
6. Você vai ver um bloco de código `firebaseConfig = {...}`. **Copie esses valores.**

> **Nota:** este site não usa o Firebase Storage (que hoje exige cadastrar cartão de crédito no plano Blaze). As fotos são salvas comprimidas direto no Firestore, que continua 100% gratuito. Você não precisa criar nada além de Authentication e Firestore.

### Parte 2 — Colar as credenciais no arquivo

1. Abra o arquivo **`index.html`** que está nesta pasta.
2. Encontre este trecho perto do topo:
   ```js
   const firebaseConfig = {
     apiKey: "COLE_AQUI_SUA_API_KEY",
     authDomain: "SEU-PROJETO.firebaseapp.com",
     projectId: "SEU-PROJETO",
     storageBucket: "SEU-PROJETO.appspot.com",
     messagingSenderId: "000000000000",
     appId: "1:000000000000:web:xxxxxxxxxxxxxxxxxxxx"
   };
   ```
3. Substitua pelos valores que você copiou no passo anterior.

### Parte 3 — Definir quem é administradora

1. Abra o arquivo **`app.js`**.
2. No topo, encontre:
   ```js
   const ADMIN_EMAILS = ["thaiza@seudominio.com"];
   ```
3. Troque pelo e-mail que você vai usar para criar sua própria conta de aluna no site (o mesmo que você vai cadastrar na tela de login). Pode colocar mais de um e-mail, separados por vírgula.
   - **Importante:** esse e-mail precisa ser cadastrado normalmente pela tela "Criar conta" do próprio site. Depois disso, ao logar com ele, o site reconhece automaticamente como administradora.

### Parte 4 — Subir para o GitHub

1. Crie um repositório novo no GitHub (pode ser privado ou público).
2. Suba estes 3 arquivos para a raiz do repositório: `index.html`, `app.js`, `README.md`.
3. Vá em **Settings > Pages** do repositório.
4. Em "Source", selecione a branch `main` e a pasta `/ (root)` → **Save**.
5. Em alguns minutos, o GitHub te dará um link tipo `https://seu-usuario.github.io/nome-do-repositorio/` — esse é o site no ar.

### Parte 5 — Testar

1. Acesse o link do GitHub Pages.
2. Crie sua conta de administradora (com o e-mail que você colocou em `ADMIN_EMAILS`).
3. Configure os prazos no Painel Admin.
4. Peça para uma aluna testar o cadastro e o envio de fotos.

## 🔒 Sobre acesso restrito (só quem tem o curso ativo)

Este site, por padrão, permite que qualquer pessoa com o link crie uma conta. Para restringir de fato a quem tem o curso ativo na Hotmart, o caminho mais simples sem programação é:

1. Não divulgue o link do site diretamente nas redes sociais.
2. Dentro da **Área de Membros da Hotmart** (onde suas alunas já acessam o curso), crie um módulo/aula chamada "Votação de Moldes" e coloque o link do site lá dentro (como botão ou texto).
3. Assim, só quem está logada na área de membros (ou seja, só quem tem o curso ativo) vai conseguir encontrar o link.

Isso não impede tecnicamente alguém de repassar o link, mas resolve o caso de uso real — divulgação só para quem tem acesso.

## 💰 Custos

O plano gratuito do Firebase (Spark) cobre tranquilamente o uso esperado para uma comunidade de alunas (milhares de leituras/gravações por dia, alguns GB de armazenamento). Você só pagaria algo se o uso crescesse muito além disso.

## 🛠️ Suporte

Se aparecer algum erro ao testar, copie a mensagem do console do navegador (F12 → aba "Console") e volte para a conversa com o Claude para ajustar.
