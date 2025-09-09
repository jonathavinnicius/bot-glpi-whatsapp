WhatsApp GLPI Bot
Este é um bot para WhatsApp que se integra com a API do sistema de chamados GLPI. Ele permite que os usuários abram, consultem, respondam e encerrem chamados diretamente pelo WhatsApp, além de receberem notificações de atualizações.

Funcionalidades
Abertura de Chamados: Um fluxo guiado para coletar categoria, título, descrição e anexos.

Consulta e Interação: Usuários podem listar seus chamados abertos, ver o histórico completo e adicionar novos acompanhamentos (respostas) com texto e anexos.

Encerramento de Chamados: Permite que o próprio usuário encerre um chamado que não é mais necessário.

Notificações (Webhook): Recebe atualizações do GLPI em tempo real e notifica o usuário no WhatsApp quando seu chamado é atualizado por um técnico.

Sessão Persistente: Salva o e-mail do usuário após o primeiro uso para agilizar interações futuras.

Configurável: Quase todos os parâmetros, como URL da API, tokens e categorias, são facilmente configuráveis em um único arquivo.

Pré-requisitos
Node.js: Versão 16.x ou superior.

GLPI: Uma instância do GLPI com a API REST habilitada.

Tokens da API do GLPI:

Um App-Token (Token de aplicativo).

Um User-Token (Token pessoal de um usuário técnico/API com as permissões necessárias para criar e gerenciar chamados).

Conta do WhatsApp: Um número de telefone para rodar o bot.

Instalação
Clone o repositório:

git clone [https://github.com/seu-usuario/whatsapp-glpi-bot.git](https://github.com/seu-usuario/whatsapp-glpi-bot.git)
cd whatsapp-glpi-bot

Instale as dependências:

npm install

Configuração
Toda a configuração do bot é feita no arquivo config.js. Abra este arquivo e preencha com as informações do seu ambiente.

Conexão com o GLPI:

GLPI_API_URL: A URL completa para o endpoint apirest.php da sua instância GLPI.

GLPI_APP_TOKEN: Seu token de aplicativo.

GLPI_USER_TOKEN: Seu token de usuário.

Categorias de Chamados:

Esta é a parte mais importante da configuração. Você precisa mapear as categorias que serão exibidas para o usuário (CATEGORIES_DISPLAY) com os IDs correspondentes no seu GLPI (CATEGORIES_API_MAP).

Para encontrar o ID de uma categoria no GLPI, vá em Configurar > Intitulados > Categorias de chamados e passe o mouse sobre o nome de uma categoria. A URL exibida no canto da tela conterá id=XX. Esse XX é o ID que você deve usar.

Configurações Gerais:

KNOWLEDGE_BASE_URL: Se você tiver um site de documentação ou FAQ, insira o link aqui. Ele será usado na opção "Base de Conhecimento" do menu.

Ajuste outras variáveis como INACTIVITY_MINUTES, TITLE_MAX_CHARS, etc., conforme sua necessidade.

Como Rodar o Bot
Execute o comando de início:

node index.js

Escaneie o QR Code:

Na primeira vez que você rodar, um QR Code será exibido no terminal.

Abra o WhatsApp no seu celular, vá em Aparelhos conectados > Conectar um aparelho e escaneie o código.

Pronto!

O bot estará conectado e pronto para receber mensagens. As informações de sessão serão salvas na pasta auth_info, então você não precisará escanear o QR Code toda vez, a menos que se desconecte.

Configurando o Webhook (Notificações)
Para que o bot notifique os usuários sobre atualizações, você precisa configurar um Webhook no GLPI.

Verifique a Acessibilidade: O servidor onde o bot está rodando precisa ser acessível pela internet para que o GLPI possa enviar as notificações. Você pode precisar usar um serviço como o ngrok durante o desenvolvimento ou garantir que a porta 3000 (ou a que você configurou em WEBHOOK_PORT) esteja aberta e redirecionada para a máquina do bot.

Crie o Webhook no GLPI:

Vá em Configurar > Notificações > Webhooks.

Crie um novo webhook com as seguintes configurações:

URL: http://SEU_IP_OU_DOMINIO_PUBLICO:3000/glpi-webhook

Tipo de requisição HTTP: POST

Formato: Texto plano

Associe o Webhook a uma Notificação:

Vá em Configurar > Notificações > Notificações.

Edite ou crie uma notificação (por exemplo, "Atualização de chamado").

Na aba "Destinatários", adicione o Webhook que você acabou de criar.

Na aba "Modelo", você precisa garantir que o template de notificação contenha o e-mail do requerente e o ID do chamado para que o bot possa identificar para quem enviar a mensagem.

Licença
Este projeto é de código aberto e pode ser utilizado e modificado livremente.
