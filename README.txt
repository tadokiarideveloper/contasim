ContaSim Realtime v4 — simulação bancária fictícia

IMPORTANTE:
- Este app é 100% simulação. Não é banco real, não tem Pix real e não movimenta dinheiro.
- Não use dados reais.

Login owner interno:
Usuário: 16581769
Senha: 0237162610

O acesso não aparece na tela inicial.
Na tela inicial, clique somente na linha "acesso colaborativo" para entrar na área da equipe.

O QUE FOI CORRIGIDO:
- Criação de cliente e colaborador atualiza a lista na hora.
- Remoção/edição/bloqueio/desbloqueio atualiza a interface imediatamente.
- Antes de login, o app busca a base mais nova no servidor.
- Sincronização entre abas do mesmo navegador por BroadcastChannel/localStorage.
- Sincronização online entre aparelhos quando o Cloudflare KV estiver configurado.

PARA TER TEMPO REAL ENTRE COMPUTADORES/CELULARES:
Este pacote inclui a pasta functions/api/state.js.
No Cloudflare Pages, crie um KV Namespace e vincule no projeto com o nome exato:
CONTASIM_DB

Depois faça o deploy com:
index.html
styles.css
app.js
functions/api/state.js

Quando estiver certo, o app mostra o selo "tempo real servidor".
Se aparecer "modo local", as mudanças ficam só naquele navegador e não vão aparecer em outro aparelho.
