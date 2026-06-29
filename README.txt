CONTA SIM — APP BANCÁRIO 100% SIMULADO

Este projeto é uma simulação visual/funcional de conta bancária.
Não tem conexão com banco real, Pix real, APIs, servidor, gateway, boleto real ou autorização financeira real.
Tudo fica salvo somente no navegador pelo localStorage.

ARQUIVOS:
- index.html
- styles.css
- app.js

COMO USAR:
1. Extraia o ZIP.
2. Abra o arquivo index.html no navegador.
3. Também pode subir a pasta no Cloudflare Pages, GitHub Pages ou hospedagem estática.

ACESSO COLABORATIVO:
Na tela inicial, no fim da página, clique no texto simples:
"acesso colaborativo"

CARGOS:
- Financeiro: vê clientes e saldos, pode aplicar bloqueios em conta/saldo, mas não pode remover bloqueios.
- Gerencial: pode autorizar/rejeitar depósitos pendentes e retirar bloqueios.
- Owner: controle total. Pode criar/remover colaboradores, alterar senhas, verificar acessos simulados, alterar saldos, remover clientes e gerenciar bloqueios.

ATUALIZAÇÃO EM TEMPO REAL:
As listas de clientes e colaboradores são atualizadas na hora após criar, editar, remover, bloquear, desbloquear ou alterar saldo.
Se o app estiver aberto em outra aba do mesmo navegador, a tela também sincroniza quando o localStorage mudar.

PIX SIMULADO:
- Pix por chave: transfere valores entre clientes cadastrados na simulação.
- Pix por QR/Copia e Cola: gera um payload fictício e um QR visual simulado. Para pagar, copie o código gerado e cole na área de pagamento por QR.

DEPÓSITOS:
Todo depósito pedido pelo cliente fica pendente.
Somente usuário Gerencial ou Owner pode autorizar o depósito para entrar no saldo.

IMPORTANTE:
Não use este projeto para captar dados reais de clientes. É apenas uma simulação/teste de interface.
