const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, getContentType, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const P = require('pino');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const FormData = require('form-data');
const express = require('express');

// === CONFIGURAÇÕES ===
const GLPI_API_URL = "http://10.81.0.7/glpi/apirest.php";
const GLPI_APP_TOKEN = "LsIQLEi8MmqhWN8oaRlptbCt4LVCKr5Kw25KBeOI";
const GLPI_USER_TOKEN = "lL5g9e1XyN979JtQ5wQUeso6RgiI9dWE7mXTO9Wb";
const INACTIVITY_MINUTES = 5;
const USER_EMAILS_PATH = './user_emails.json';
const WEBHOOK_PORT = 3000;
const DEBUG_MODE = false; // Mude para true para ver logs detalhados
const TITLE_MAX_CHARS = 20;
const DESCRIPTION_MIN_CHARS = 25;

// Nova constante para desduplicação de webhooks
const BOT_INITIATED_UPDATE_COOLDOWN_MS = 30 * 1000; // 30 segundos de cooldown
// Atraso para processar webhooks (garante que a mensagem do bot chegue primeiro)
const WEBHOOK_PROCESSING_DELAY_MS = 7 * 1000; // 7 segundos de atraso

let userStates = {};
let userEmails = {};

// Map para armazenar os timers de processamento de webhook por usuário
const pendingWebhookTimers = new Map();
// Map para armazenar o conteúdo do último webhook recebido por usuário
const userPendingWebhookContent = new Map();
// Map para controlar a supressão de webhooks por ação do bot
const botActionSuppressions = new Map();

const CATEGORIES_DISPLAY = {
    '1': '🖥️ GW sistemas',
    '2': '📧 E-mail',
    '3': '🌐 Rede interna e internet',
    '4': '💳 Pamcard',
    '5': '💻 Hardware',
    '6': '📱 Celulares',
    '7': '❓ Dúvida',
    '8': '📦 Disponibilização de equipamento',
    '9': '💡 Outros'
};
const CATEGORIES_API_MAP = {
    '🖥️ GW sistemas': 35,
    '📧 E-mail': 9,
    '🌐 Rede interna e internet': 42,
    '💳 Pamcard': 78,
    '💻 Hardware': 15,
    '📱 Celulares': 80,
    '❓ Dúvida': 8,
    '📦 Disponibilização de equipamento': 3,
    '💡 Outros': 85
};
const GLPI_STATUS_MAP = {
    1: 'Novo',
    2: 'Em atendimento (atribuído)',
    3: 'Em atendimento (planejado)',
    4: 'Pendente',
    5: 'Solucionado',
    6: 'Fechado'
};

// --- FUNÇÕES AUXILIARES ---
function getExtensionFromMime(mimeType) {
    switch (mimeType) {
        case 'image/jpeg': return '.jpeg';
        case 'image/png': return '.png';
        case 'image/gif': return '.gif';
        case 'application/pdf': return '.pdf';
        default: return '';
    }
}

function loadUserEmails() {
    try {
        if (fs.existsSync(USER_EMAILS_PATH)) {
            let fileContent = fs.readFileSync(USER_EMAILS_PATH, 'utf8');
            const cleanedContent = fileContent.replace(/,\s*([}\]])/g, '$1');
            userEmails = JSON.parse(cleanedContent);
            console.log('✅ Emails dos usuários carregados.');
        } else {
            console.log('ℹ️ Arquivo de emails não encontrado, será criado um novo.');
        }
    } catch (error) {
        console.error('❌ Erro ao carregar emails:', error);
    }
}

async function saveUserEmails() {
    try {
        await fs.promises.writeFile(USER_EMAILS_PATH, JSON.stringify(userEmails, null, 2));
        if (DEBUG_MODE) console.log('DEBUG: Emails salvos.');
    } catch (error) {
        console.error('❌ Erro ao salvar emails:', error);
    }
}

function stripHtmlTags(htmlContent) {
    if (!htmlContent) return '';
    let content = htmlContent.toString();
    content = content.replace(/&amp;/g, '&')
                      .replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>')
                      .replace(/&quot;/g, '\"')
                      .replace(/&#39;/g, '\'')
                      .replace(/&#60;/g, '<')
                      .replace(/&#62;/g, '>')
                      .replace(/&nbsp;/g, ' ');
    content = content.replace(/<[^>]*>?/gm, '');
    content = content.replace(/(\r\n|\n|\r){2,}/g, '\n');
    return content.trim();
}

// === INÍCIO DO BOT ===
async function startBot() {
    loadUserEmails();
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const sock = makeWASocket({
        logger: P({ level: 'silent' }),
        auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log("📱 Escaneie o QR Code:");
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') console.log('✅ Bot WhatsApp conectado!');
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log(`❌ Conexão fechada. Reconectando: ${shouldReconnect}`);
            if (shouldReconnect) startBot();
        }
    });

    function resetInactivityTimer(from) {
        if (userStates[from]?.timeoutId) clearTimeout(userStates[from].timeoutId);
        if (userStates[from]) {
            userStates[from].timeoutId = setTimeout(async () => {
                if (userStates[from]) {
                    if (DEBUG_MODE) console.log(`DEBUG: Sessão para ${from} expirou.`);
                    if (userStates[from].sessionToken) await closeSession(userStates[from].sessionToken);
                    await sock.sendMessage(from, { text: `Sua sessão foi encerrada por *inatividade*. Para começar de novo, envie qualquer mensagem. 👋` });
                    delete userStates[from];
                }
            }, INACTIVITY_MINUTES * 60 * 1000);
        }
    }

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (msg.key.fromMe || !msg.message) return;

        const from = msg.key.remoteJid;
        const contentType = getContentType(msg.message);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        const senderName = msg.pushName || 'Usuário';
        const normalizedText = text?.toLowerCase().trim();

        if (DEBUG_MODE) {
            console.log(`\n📩 Msg de: ${senderName} (${from}) -> \"${text || contentType}\"`);
        }

        if (userStates[from]?.timeoutId) clearTimeout(userStates[from].timeoutId);

        if (normalizedText === '0') {
            if(userStates[from]?.sessionToken) await closeSession(userStates[from].sessionToken);
            delete userStates[from];
            await sock.sendMessage(from, { text: "Tudo bem, processo cancelado. Estarei aqui se precisar! 👋" });
            return;
        }

        if (!userStates[from]) {
            await showMainMenu(from, senderName);
            return;
        }

        const currentState = userStates[from].state;

        // Roteamento baseado no estado atual do usuário
        switch (currentState) {
            case 'menu':
                await handleMenuOption(from, normalizedText, senderName);
                break;
            case 'awaiting_category':
                await handleCategorySelection(from, normalizedText);
                break;
            case 'awaiting_title':
                await handleTitleInput(from, text);
                break;
            case 'awaiting_description':
                await handleDescriptionInput(from, text);
                break;
            case 'awaiting_email_confirmation':
                await handleEmailConfirmation(from, normalizedText);
                break;
            case 'awaiting_email':
                await handleEmailInput(from, normalizedText);
                break;
            case 'awaiting_ip':
                await handleIpInput(from, text);
                break;
            case 'awaiting_attachment_option':
                await handleAttachmentOption(from, normalizedText, msg);
                break;
            case 'awaiting_creation_confirmation':
                await handleCreationConfirmation(from, normalizedText);
                break;
            case 'awaiting_email_for_flow':
                await handleEmailForFlow(from, normalizedText);
                break;
            case 'awaiting_ticket_selection':
                await handleTicketSelection(from, normalizedText);
                break;
            case 'awaiting_ticket_to_cancel':
                await handleTicketCancellationSelection(from, normalizedText);
                break;
            case 'awaiting_attachment_decision':
                await handleAttachmentDecision(from, normalizedText);
                break;
            case 'awaiting_followup_decision':
                await handleFollowupDecision(from, normalizedText);
                break;
            case 'awaiting_followup_text':
                await handleFollowupTextInput(from, text);
                break;
            case 'awaiting_followup_attachment_option':
                await handleFollowupAttachmentOption(from, normalizedText, msg);
                break;
        }
    });

    // --- SERVIDOR DE WEBHOOKS ---
    const app = express();
    app.use(express.text({ type: '*/*' }));

    async function processDelayedWebhook(userJid, rawBody) {
        userPendingWebhookContent.delete(userJid);
        if (!userJid) {
            console.error('❌ Erro: userJid não definido para webhook atrasado.');
            return;
        }
        
        try {
            const regexTitulo = /Título\s*:\s*([^\n]+)/;
            const matchTicketId = rawBody.match(/Chamado[:\s#]+(\d+)/);
            const regexEmailRequerente = /(?:<b>)?\s*(?:📧)?\s*E-mail:\s*(?:<\/b>)?\s*([^<\s]+)/;
            
            const matchTitulo = rawBody.match(regexTitulo);
            const matchEmailRequerente = rawBody.match(regexEmailRequerente);

            if (!matchTitulo || !matchEmailRequerente || !matchTicketId) {
                if (DEBUG_MODE) console.error('DEBUG: Não foi possível extrair ID, título ou e-mail do webhook. Conteúdo:', rawBody);
                return;
            }

            const titulo = stripHtmlTags(matchTitulo[1]);
            const emailRequerente = stripHtmlTags(matchEmailRequerente[1]);
            const webhookTicketId = matchTicketId ? parseInt(matchTicketId[1], 10) : null;
            
            const userJidForWebhook = Object.keys(userEmails).find(key => userEmails[key] === emailRequerente);

            if (userJidForWebhook) {
                const suppression = botActionSuppressions.get(userJidForWebhook);
                if (suppression &&
                    suppression.ticketId === webhookTicketId &&
                    (Date.now() - suppression.timestamp < BOT_INITIATED_UPDATE_COOLDOWN_MS)) {
                    
                    if (DEBUG_MODE) console.log(`DEBUG: Webhook para ${userJidForWebhook} (ticket #${webhookTicketId}) ignorado (ação do bot).`);
                    return;
                }
                
                const message = `🔔 *Nova atualização no chamado* 🔔\n\n` +
                                `*Chamado:* #${webhookTicketId}\n` +
                                `*Título:* ${titulo}\n\n` +
                                `_Para ver os detalhes, envie uma mensagem e escolha a opção 3._`;

                await sock.sendMessage(userJidForWebhook, { text: message });
                console.log(`✅ Notificação de webhook enviada para ${userJidForWebhook}`);

            } else {
                if (DEBUG_MODE) console.log(`DEBUG: Usuário com email ${emailRequerente} não encontrado. Notificação não enviada.`);
            }

        } catch (error) {
            console.error(`❌ Erro ao processar o webhook atrasado para userJid ${userJid}:`, error.message);
        }
    }

    app.post('/glpi-webhook', async (req, res) => {
        if (DEBUG_MODE) console.log("🔔 Webhook do GLPI recebido!");
        const rawBody = req.body;
        
        try {
            const regexEmailRequerente = /(?:<b>)?\s*(?:📧)?\s*E-mail:\s*(?:<\/b>)?\s*([^<\s]+)/;
            const matchEmailRequerente = rawBody.match(regexEmailRequerente);

            if (!matchEmailRequerente) {
                if (DEBUG_MODE) console.error('DEBUG: Não foi possível extrair o e-mail do requerente do webhook. Body:', rawBody);
                return res.status(400).send('Dados do webhook inválidos.');
            }

            const emailRequerente = stripHtmlTags(matchEmailRequerente[1]);
            const userJid = Object.keys(userEmails).find(key => userEmails[key] === emailRequerente);

            if (userJid) {
                if (pendingWebhookTimers.has(userJid)) {
                    clearTimeout(pendingWebhookTimers.get(userJid));
                }
                
                userPendingWebhookContent.set(userJid, rawBody);

                const timer = setTimeout(() => {
                    const latestRawBody = userPendingWebhookContent.get(userJid);
                    if (latestRawBody) {
                        processDelayedWebhook(userJid, latestRawBody);
                    }
                }, WEBHOOK_PROCESSING_DELAY_MS);
                
                pendingWebhookTimers.set(userJid, timer);

            } else {
                if (DEBUG_MODE) console.log(`DEBUG: Usuário com email ${emailRequerente} não encontrado no mapeamento de webhook.`);
            }

            res.status(200).send('Webhook recebido e agendado.');

        } catch (error) {
            console.error("❌ Erro ao processar o webhook (fase de agendamento):", error.message);
            res.status(500).send('Erro interno do servidor ao processar o webhook.');
        }
    });

    app.listen(WEBHOOK_PORT, '0.0.0.0', () => {
        console.log(`🚀 Servidor de webhooks rodando na porta ${WEBHOOK_PORT} e escutando em todas as interfaces de rede.`);
    });
    
    // --- FUNÇÕES DE FLUXO DE CONVERSA ---
    async function showMainMenu(from, senderName) {
        await sock.sendMessage(from, { text: `Olá ${senderName}! 👋 Eu sou o bot de suporte do GLPI.\n\nComo posso ajudar?\n\n*1.* 🎫 Abrir um chamado\n*2.* 📚 Site de procedimentos TIC\n*3.* 🔎 Consuar/Responder um chamado\n*4.* ❌ Cancelar um chamado\n\n_(Digite *'0'* a qualquer momento para sair)_` });
        userStates[from] = { state: 'menu' };
        resetInactivityTimer(from);
    }

    async function handleMenuOption(from, normalizedText, senderName) {
        if (normalizedText === '1') {
            userStates[from].state = 'awaiting_category';
            let categoryMessage = `Ok, vamos abrir um chamado.\n\nPrimeiro, escolha uma *categoria*:\n\n`;
            for (const key in CATEGORIES_DISPLAY) categoryMessage += `*${key}.* ${CATEGORIES_DISPLAY[key]}\n`;
            categoryMessage += `\n_(Digite *'0'* para sair)_`;
            await sock.sendMessage(from, { text: categoryMessage });
            resetInactivityTimer(from);
        } else if (normalizedText === '2') {
            await sock.sendMessage(from, { text: "Aqui está o link para o nosso site de procedimentos de TIC:\nhttps://focuslog.sharepoint.com/sites/Procedimentos-TIC\n\nConsulta finalizada. Se precisar de algo mais, é só chamar! 👋" });
            delete userStates[from];
        } else if (normalizedText === '3' || normalizedText === '4') {
            const nextFlow = normalizedText === '3' ? 'awaiting_ticket_selection' : 'awaiting_ticket_to_cancel';
            const actionText = normalizedText === '3' ? 'consultar' : 'cancelar';
            const storedEmail = userEmails[from];
            if (storedEmail) {
                await listUserOpenTickets(from, storedEmail, nextFlow, actionText);
            } else {
                userStates[from].state = 'awaiting_email_for_flow';
                userStates[from].nextFlow = nextFlow;
                userStates[from].actionText = actionText;
                await sock.sendMessage(from, { text: `Para ${actionText} seus chamados, por favor, informe seu *email* de cadastro no GLPI.` });
                resetInactivityTimer(from);
            }
        } else {
            await sock.sendMessage(from, { text: 'Opção inválida. Por favor, digite *1*, *2*, *3* ou *4*.' });
            resetInactivityTimer(from);
        }
    }

    async function handleCategorySelection(from, normalizedText) {
        const categoryName = CATEGORIES_DISPLAY[normalizedText];
        if (categoryName) {
            userStates[from].category = categoryName;
            userStates[from].state = 'awaiting_title';
            await sock.sendMessage(from, { text: `✍️ Categoria selecionada. Agora, por favor, adicione um *título* para o seu chamado (máx. ${TITLE_MAX_CHARS} caracteres).\n\n_(Digite *'0'* para sair)_` });
        } else {
            await sock.sendMessage(from, { text: `Opção inválida. Escolha um número de *1* a *${Object.keys(CATEGORIES_DISPLAY).length}*.` });
        }
        resetInactivityTimer(from);
    }

    async function handleTitleInput(from, text) {
        if (!text || text.trim().length === 0) {
            await sock.sendMessage(from, { text: `✍️ O título não pode estar vazio. Por favor, digite um título para o seu chamado.` });
            resetInactivityTimer(from);
            return;
        }
        if (text.length > TITLE_MAX_CHARS) {
            await sock.sendMessage(from, { text: `❌ Título muito longo! Ele deve ter no máximo ${TITLE_MAX_CHARS} caracteres (o seu tem ${text.length}).\n\nPor favor, digite um título mais curto ou '0' para sair.` });
            resetInactivityTimer(from);
            return; 
        }

        userStates[from].title = text;
        userStates[from].state = 'awaiting_description';
        await sock.sendMessage(from, { text: `✍️ Ótimo! Agora, envie uma *descrição* do problema com pelo menos ${DESCRIPTION_MIN_CHARS} caracteres.\n\n_(Digite *'0'* para sair)_` });
        resetInactivityTimer(from);
    }

    async function handleDescriptionInput(from, text) {
        if (!text || text.trim().length < DESCRIPTION_MIN_CHARS) {
            await sock.sendMessage(from, { text: `❌ Descrição muito curta! Ela deve ter pelo menos ${DESCRIPTION_MIN_CHARS} caracteres para detalhar bem o problema (a sua tem ${text.trim().length}).\n\nPor favor, descreva com mais detalhes ou digite '0' para sair.` });
            resetInactivityTimer(from);
            return;
        }

        userStates[from].description = text;
        const storedEmail = userEmails[from];
        if (storedEmail) {
            userStates[from].state = 'awaiting_email_confirmation';
            await sock.sendMessage(from, { text: `Encontrei este e-mail associado ao seu número: *${storedEmail}*\n\nEstá correto?\n\n*1.* Sim\n*2.* Não\n\n_(Digite *'0'* para sair)_` });
        } else {
            userStates[from].state = 'awaiting_email';
            await sock.sendMessage(from, { text: `Para continuar, informe seu *email* de cadastro no GLPI.\n\n_(Digite *'0'* para sair)_` });
        }
        resetInactivityTimer(from);
    }

    async function handleEmailConfirmation(from, normalizedText) {
        if (normalizedText === '1') {
            userStates[from].email = userEmails[from];
            userStates[from].state = 'awaiting_ip';
            await sock.sendMessage(from, { text: `Ok. Agora, informe o *IP da sua máquina*.\n\n💡 *Dica:* Posicione o mouse sobre o ícone azul do UltraVNC (👁️) perto do relógio.\n\n_(Digite *'0'* para sair)_` });
        } else if (normalizedText === '2') {
            userStates[from].state = 'awaiting_email';
            await sock.sendMessage(from, { text: `Ok. Por favor, digite o seu *email* correto.\n\n_(Digite *'0'* para sair)_` });
        } else {
            await sock.sendMessage(from, { text: 'Opção inválida. Digite *1* para Sim ou *2* para Não.' });
        }
        resetInactivityTimer(from);
    }

    async function handleEmailInput(from, normalizedText) {
        userStates[from].email = normalizedText;
        userEmails[from] = normalizedText;
        await saveUserEmails();
        userStates[from].state = 'awaiting_ip';
        await sock.sendMessage(from, { text: `Ok, email salvo! Agora, informe o *IP da sua máquina*.\n\n💡 *Dica:* Posicione o mouse sobre o ícone azul do UltraVNC (👁️) perto do relógio.\n\n_(Digite *'0'* para sair)_` });
        resetInactivityTimer(from);
    }

    async function handleIpInput(from, text) {
        userStates[from].ip = text;
        userStates[from].attachments = [];
        userStates[from].state = 'awaiting_attachment_option';
        await sock.sendMessage(from, { text: `Deseja adicionar um anexo (*imagem* ou *documento*)?\n\n*1.* Sim\n*2.* Não\n\n_(Pode enviar o arquivo diretamente)_\n\n_(Digite *'0'* para sair)_` });
        resetInactivityTimer(from);
    }

    async function handleAttachmentOption(from, normalizedText, msg) {
        const contentType = getContentType(msg.message);
        if (contentType === 'imageMessage' || contentType === 'documentMessage') {
            const messageType = contentType.replace('Message', '');
            const stream = await downloadContentFromMessage(msg.message[contentType], messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

            userStates[from].attachments.push({ base64Content: buffer.toString('base64'), mimeType: msg.message[contentType].mimetype });
            userStates[from].state = 'awaiting_attachment_option';
            await sock.sendMessage(from, { text: `✅ *Anexo recebido!* Deseja adicionar mais um?\n\n*1.* Sim (ou envie o arquivo)\n*2.* Não (finalizar)\n\n_(Digite *'0'* para sair)_` });
        } else if (normalizedText === '1') {
            await sock.sendMessage(from, { text: `👍 Ok, pode enviar o arquivo.` });
        } else if (normalizedText === '2') {
            userStates[from].senderName = msg.pushName || 'Usuário';
            await showTicketSummaryAndConfirm(from, userStates[from]);
        } else {
             await sock.sendMessage(from, { text: `Opção inválida ou anexo não detectado. Por favor, envie o anexo ou digite *1* para adicionar ou *2* para finalizar.` });
        }
        resetInactivityTimer(from);
    }

    async function showTicketSummaryAndConfirm(from, ticketData) {
        const { category, title, description } = ticketData;
        let summary = "📝 *Resumo do Chamado*\n\n";
        summary += `*Categoria:* ${category}\n`;
        summary += `*Título:* ${title}\n`;
        summary += `*Descrição:* ${description}\n\n`;
        summary += "Você confirma as informações e deseja criar o chamado?\n\n*1.* Sim\n*2.* Não, cancelar tudo\n\n_(Digite *'0'* para sair)_";
        userStates[from].state = 'awaiting_creation_confirmation';
        await sock.sendMessage(from, { text: summary });
        resetInactivityTimer(from);
    }

    async function handleCreationConfirmation(from, normalizedText) {
        if (normalizedText === '1') {
            const senderName = userStates[from].senderName;
            await handleTicketCreation(from, senderName, userStates[from]);
        } else if (normalizedText === '2') {
            delete userStates[from];
            await sock.sendMessage(from, { text: "Ok, a criação do chamado foi cancelada. Se precisar de algo mais, é só começar de novo. 👋" });
        } else {
            await sock.sendMessage(from, { text: 'Opção inválida. Por favor, digite *1* para Sim ou *2* para Não.' });
            resetInactivityTimer(from);
        }
    }

    async function handleEmailForFlow(from, normalizedText) {
        userEmails[from] = normalizedText;
        await saveUserEmails();
        const { nextFlow, actionText } = userStates[from];
        await listUserOpenTickets(from, normalizedText, nextFlow, actionText);
    }

    // --- Funções de Consulta e Resposta a Chamados ---
    async function handleTicketSelection(from, normalizedText) {
        const choice = parseInt(normalizedText, 10);
        const { foundTickets } = userStates[from];

        if (isNaN(choice) || choice < 1 || choice > foundTickets.length) {
            await sock.sendMessage(from, { text: `Opção inválida. Escolha um número de 1 a ${foundTickets.length}.\n\n_(Digite *'0'* para sair)_` });
            resetInactivityTimer(from);
            return;
        }

        const selectedTicket = foundTickets[choice - 1];
        userStates[from].selectedTicketId = selectedTicket.id; // Salva o ID do ticket para uso posterior
        userStates[from].selectedTicketTitle = selectedTicket.title;
        await sock.sendMessage(from, { text: `Buscando detalhes do chamado *#${selectedTicket.id}*... ⏳` });

        let sessionToken = null;
        try {
            sessionToken = await initSession();
            userStates[from].sessionToken = sessionToken;

            const ticketDetails = await axios.get(`${GLPI_API_URL}/Ticket/${selectedTicket.id}`, {
                headers: { 'Session-Token': sessionToken, 'App-Token': GLPI_APP_TOKEN }
            });
            const followups = await axios.get(`${GLPI_API_URL}/Ticket/${selectedTicket.id}/TicketFollowup`, {
                headers: { 'Session-Token': sessionToken, 'App-Token': GLPI_APP_TOKEN }
            });
            
            const status = GLPI_STATUS_MAP[ticketDetails.data.status] || 'Desconhecido';

            let response = `📋 *Detalhes do Chamado*\n` +
                          `🆔 *Chamado:* #${selectedTicket.id}\n` +
                          `📝 *Título:* ${selectedTicket.title}\n` +
                          `📌 *Status:* ${status}\n` +
                          `📅 *Aberto em:* ${new Date(ticketDetails.data.date_creation).toLocaleString('pt-BR')}\n` +
                          `🔄 *Última atualização:* ${new Date(ticketDetails.data.date_mod).toLocaleString('pt-BR')}\n`;

            let historyText = "\n💬 *Histórico de Atualizações:*\n\n";

            // Adiciona a descrição inicial
            const mainContentExtraction = cleanAndExtractImages(ticketDetails.data.content);
            if (mainContentExtraction.cleanedText) {
                const creationDate = new Date(ticketDetails.data.date_creation).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ' -');
                historyText += `*${creationDate}:*\n${mainContentExtraction.cleanedText}\n\n`;
            }

            // Adiciona os acompanhamentos
            if (followups.data?.length > 0) {
                const sortedFollowups = followups.data.sort((a, b) => new Date(a.date) - new Date(b.date));
                sortedFollowups.forEach(f => {
                    const followupExtraction = cleanAndExtractImages(f.content);
                    if (followupExtraction.cleanedText) {
                        const followupDate = new Date(f.date).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ' -');
                        historyText += `*${followupDate}:*\n${followupExtraction.cleanedText}\n\n`;
                    }
                });
            }

            response += historyText;
            await sock.sendMessage(from, { text: response });

            // Pergunta se deseja adicionar uma resposta
            userStates[from].state = 'awaiting_followup_decision';
            await sock.sendMessage(from, { text: `Deseja adicionar uma resposta a este chamado?\n\n*1.* Sim\n*2.* Não\n\n_(Digite *'0'* para sair)_` });
            resetInactivityTimer(from);

        } catch (error) {
            console.error("❌ Erro ao buscar detalhes do chamado:", error.response?.data || error.message);
            await sock.sendMessage(from, { text: '⚠️ Ocorreu um erro ao buscar os detalhes do chamado.' });
            if (sessionToken) await closeSession(sessionToken);
            delete userStates[from];
        }
    }
    
    async function handleFollowupDecision(from, normalizedText) {
        if (normalizedText === '1') {
            userStates[from].state = 'awaiting_followup_text';
            await sock.sendMessage(from, { text: `Ok, por favor, digite a sua resposta.\n\n_(Digite *'0'* para sair)_` });
        } else if (normalizedText === '2') {
            await sock.sendMessage(from, { text: "Consulta finalizada. Se precisar de algo mais, é só chamar! 👋" });
            if (userStates[from]?.sessionToken) await closeSession(userStates[from].sessionToken);
            delete userStates[from];
        } else {
            await sock.sendMessage(from, { text: 'Opção inválida. Por favor, digite *1* para Sim ou *2* para Não.' });
        }
        resetInactivityTimer(from);
    }

    async function handleFollowupTextInput(from, text) {
        userStates[from].followupText = text;
        userStates[from].attachments = []; // Reinicia os anexos para a resposta
        userStates[from].state = 'awaiting_followup_attachment_option';
        await sock.sendMessage(from, { text: `Deseja adicionar um anexo à sua resposta?\n\n*1.* Sim\n*2.* Não\n\n_(Pode enviar o arquivo diretamente)_\n\n_(Digite *'0'* para sair)_` });
        resetInactivityTimer(from);
    }
    
    async function handleFollowupAttachmentOption(from, normalizedText, msg) {
        const contentType = getContentType(msg.message);
        
        if (contentType === 'imageMessage' || contentType === 'documentMessage') {
            const messageType = contentType.replace('Message', '');
            const stream = await downloadContentFromMessage(msg.message[contentType], messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    
            userStates[from].attachments.push({ base64Content: buffer.toString('base64'), mimeType: msg.message[contentType].mimetype });
            userStates[from].state = 'awaiting_followup_attachment_option';
            await sock.sendMessage(from, { text: `✅ *Anexo recebido!* Deseja adicionar mais um?\n\n*1.* Sim (ou envie o arquivo)\n*2.* Não (enviar resposta)\n\n_(Digite *'0'* para sair)_` });
        } else if (normalizedText === '1') {
            await sock.sendMessage(from, { text: `👍 Ok, pode enviar o anexo.` });
        } else if (normalizedText === '2') {
            await sock.sendMessage(from, { text: `Enviando sua resposta ao chamado *#${userStates[from].selectedTicketId}*... ⏳` });
            await submitFollowupAndAttachments(from);
        } else {
            await sock.sendMessage(from, { text: `Opção inválida. Por favor, envie um anexo ou digite *1* ou *2*.` });
        }
        resetInactivityTimer(from);
    }

    async function handleTicketCancellationSelection(from, normalizedText) {
        const choice = parseInt(normalizedText, 10);
        const { foundTickets } = userStates[from];
        
        if (isNaN(choice) || choice < 1 || choice > foundTickets.length) {
            await sock.sendMessage(from, { text: `Opção inválida. Escolha um número de 1 a ${foundTickets.length}.\n\n_(Digite *'0'* para sair)_` });
            resetInactivityTimer(from);
            return;
        }

        const selectedTicket = foundTickets[choice - 1];
        await sock.sendMessage(from, { text: `❌ Fechando o chamado *#${selectedTicket.id}*...` });

        let sessionToken = null;
        try {
            sessionToken = await initSession();
            const statusPayload = { input: { status: 6 } }; // Status 6 = Fechado
            await axios.put(`${GLPI_API_URL}/Ticket/${selectedTicket.id}`, statusPayload, {
                headers: { 'Session-Token': sessionToken, 'App-Token': GLPI_APP_TOKEN }
            });

            botActionSuppressions.set(from, {
                ticketId: selectedTicket.id,
                timestamp: Date.now()
            });
            setTimeout(() => {
                const suppression = botActionSuppressions.get(from);
                if (suppression && suppression.ticketId === selectedTicket.id) {
                    botActionSuppressions.delete(from);
                }
            }, BOT_INITIATED_UPDATE_COOLDOWN_MS);

            await sock.sendMessage(from, { text: `✅ Chamado *#${selectedTicket.id}* fechado com sucesso!` });
            
        } catch (error) {
            console.error("❌ Erro ao fechar o chamado:", error.response?.data || error.message);
            await sock.sendMessage(from, { text: `⚠️ Ocorreu um erro ao tentar fechar o chamado.` });
        } finally {
            if (sessionToken) await closeSession(sessionToken);
            delete userStates[from];
        }
    }

    async function handleAttachmentDecision(from, normalizedText) {
        // Esta função não é mais chamada diretamente, pois a lógica de anexos agora é interna
        // à consulta (através da extração de base64). Mantida por segurança.
        await sock.sendMessage(from, { text: "Consulta finalizada. Se precisar de algo mais, é só chamar! 👋" });
        if (userStates[from]?.sessionToken) await closeSession(userStates[from].sessionToken);
        delete userStates[from];
    }
    
    // --- FUNÇÕES DE INTERAÇÃO COM API GLPI ---
    async function initSession() {
        try {
            const session = await axios.get(`${GLPI_API_URL}/initSession`, {
                headers: { 'Authorization': `user_token ${GLPI_USER_TOKEN}`, 'App-Token': GLPI_APP_TOKEN }
            });
            return session.data.session_token;
        } catch (error) {
            console.error("❌ Erro ao iniciar sessão GLPI:", error.message);
            throw new Error("Não foi possível iniciar uma sessão com o GLPI.");
        }
    }

    async function closeSession(sessionToken) {
        if (!sessionToken) return;
        try {
            await axios.get(`${GLPI_API_URL}/killSession`, {
                headers: { 'Session-Token': sessionToken, 'App-Token': GLPI_APP_TOKEN }
            });
            if (DEBUG_MODE) console.log("DEBUG: Sessão GLPI finalizada com sucesso.");
        } catch (e) {
            if (DEBUG_MODE) console.log("DEBUG: Erro ao finalizar sessão (ignorado).", e.message);
        }
    }
    
    async function listUserOpenTickets(from, email, nextState, actionText) {
        await sock.sendMessage(from, { text: `🔎 Buscando chamados de *${email}*...` });
        let sessionToken = null;
        try {
            sessionToken = await initSession();
            userStates[from].sessionToken = sessionToken; // Salva o token para uso futuro

            const userSearch = await axios.get(`${GLPI_API_URL}/search/User`, {
                headers: { 'Session-Token': sessionToken, 'App-Token': GLPI_APP_TOKEN },
                params: {
                    'criteria[0][field]': '5', 'criteria[0][searchtype]': 'contains', 'criteria[0][value]': email,
                    'forcedisplay[0]': '2'
                }
            });

            if (userSearch.data.totalcount === 0) {
                await sock.sendMessage(from, { text: `⚠️ Nenhum usuário encontrado para o e-mail *${email}*.` });
                await closeSession(sessionToken);
                delete userStates[from];
                return;
            }
            const glpiUserId = userSearch.data.data[0]['2'];

            const ticketsResp = await axios.get(`${GLPI_API_URL}/search/Ticket`, {
                headers: { 'Session-Token': sessionToken, 'App-Token': GLPI_APP_TOKEN },
                params: {
                    'criteria[0][field]': '4', 'criteria[0][searchtype]': 'equals', 'criteria[0][value]': glpiUserId,
                    'forcedisplay[0]': '2', 'forcedisplay[1]': '1', 'forcedisplay[2]': '12', 'range': '0-50'
                }
            });

            const tickets = ticketsResp.data.data || [];
            const openTickets = tickets.filter(t => t['12'] < 5); // Status < 5 (Solucionado)

            if (openTickets.length === 0) {
                await sock.sendMessage(from, { text: `Você não possui chamados em aberto no momento.` });
                await closeSession(sessionToken);
                delete userStates[from];
                return;
            }

            let ticketListMessage = `Encontrei *${openTickets.length}* chamado(s) em aberto. Qual você deseja ${actionText}?\n\n`;
            const foundTickets = [];
            openTickets.forEach((ticket, index) => {
                ticketListMessage += `*${index + 1}.* #${ticket['2']} - ${ticket['1']}\n`;
                foundTickets.push({ id: ticket['2'], title: ticket['1'] });
            });
            ticketListMessage += `\n_(Digite *'0'* para sair)_`;

            userStates[from].foundTickets = foundTickets;
            userStates[from].state = nextState;
            await sock.sendMessage(from, { text: ticketListMessage });
            resetInactivityTimer(from);
            // Não fecha a sessão aqui, ela será usada na próxima etapa
        } catch (error) {
            console.error("❌ Erro ao listar chamados:", error.response?.data || error.message);
            await sock.sendMessage(from, { text: '⚠️ Ocorreu um erro ao buscar seus chamados. Tente novamente mais tarde.' });
            if (sessionToken) await closeSession(sessionToken);
            delete userStates[from];
        }
    }
    
    function cleanAndExtractImages(htmlContent) {
        if (!htmlContent) return { cleanedText: '', images: [] };
        // Função para limpar HTML e extrair imagens base64. (Mantida como no seu código original)
        let content = htmlContent;
        content = content.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&#39;/g, '\'').replace(/&#60;/g, '<').replace(/&#62;/g, '>').replace(/&nbsp;/g, ' ');
        content = content.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<p[^>]*>/gi, '');
        content = content.replace(/<[^>]*>?/gm, '');
        return { cleanedText: content.trim().replace(/\n\s*\n/g, '\n'), images: [] };
    }

    async function handleTicketCreation(from, senderName, ticketData) {
        let sessionToken = null;
        try {
            sessionToken = await initSession();
            const { glpiUserId, glpiUserName } = await getGlpiUser(sessionToken, ticketData.email, from);
            const ticketId = await createGlpiTicket(sessionToken, ticketData, glpiUserId, glpiUserName, senderName, from);
            await processAttachments(sessionToken, ticketId, ticketData);
            await sock.sendMessage(from, { text: `✅ Chamado *#${ticketId}* aberto com sucesso!\n\nVocê pode me mandar uma nova mensagem para iniciar um novo chamado.` });
        } catch (error) {
            console.error("❌ Erro na criação do chamado:", error.response?.data || error.message);
            await sock.sendMessage(from, { text: '⚠️ Ocorreu um erro ao abrir seu chamado.' });
        } finally {
            if (sessionToken) await closeSession(sessionToken);
            delete userStates[from];
        }
    }

    async function getGlpiUser(sessionToken, email, from) {
        if (!email) return { glpiUserId: null, glpiUserName: 'Não encontrado' };
        try {
            const { data } = await axios.get(`${GLPI_API_URL}/search/User`, {
                headers: { 'Session-Token': sessionToken, 'App-Token': GLPI_APP_TOKEN },
                params: {
                    'criteria[0][field]': '5', 'criteria[0][searchtype]': 'contains', 'criteria[0][value]': email,
                    'forcedisplay[0]': '2', 'forcedisplay[1]': '9', 'forcedisplay[2]': '34'
                }
            });
            if (data?.totalcount > 0) {
                const userData = data.data[0];
                return { glpiUserId: userData['2'], glpiUserName: `${userData['9'] || ''} ${userData['34'] || ''}`.trim() || 'Nome não cadastrado' };
            } else {
                await sock.sendMessage(from, { text: `⚠️ *Atenção:* Não encontrei um usuário no GLPI com o email *'${email}'*. O chamado será aberto, mas não associado ao seu cadastro.` });
                return { glpiUserId: null, glpiUserName: 'Não encontrado' };
            }
        } catch (error) {
            if (DEBUG_MODE) console.error("DEBUG: Erro ao procurar usuário:", error.message);
            return { glpiUserId: null, glpiUserName: 'Não encontrado' };
        }
    }

    async function createGlpiTicket(sessionToken, ticketData, glpiUserId, glpiUserName, senderName, from) {
        const { title, category, description, email, attachments, ip } = ticketData;

        let ticketContent = `<p><b>👤 Nome (GLPI):</b> ${glpiUserName}</p>` +
                            `<p><b>📧 E-mail:</b> ${email || 'N/A'}</p>` +
                            `<p><b>💻 IP da máquina:</b> ${ip || 'N/A'}</p>` +
                            `<p><b>📞 Número (WhatsApp):</b> ${from.split('@')[0]}</p><hr>` +
                            `<p><b>📝 Descrição:</b></p><p>${description.replace(/\n/g, '<br>')}</p>`;

        const imagesContent = attachments
            .filter(att => att.mimeType.startsWith('image/'))
            .map(att => `<p><img src=\"data:${att.mimeType};base64,${att.base64Content}\" /></p>`)
            .join('');

        if (imagesContent) {
            ticketContent += `<hr><p><b>🖼️ Imagens Anexas:</b></p>${imagesContent}`;
        }

        const ticketInput = {
            name: `${title} - ${senderName} via WhatsApp`,
            content: ticketContent,
            requesttypes_id: 1,
            urgency: 3,
            itilcategories_id: CATEGORIES_API_MAP[category] || 0
        };

        if (glpiUserId) {
            ticketInput._users_id_requester = glpiUserId;
        }

        const { data } = await axios.post(`${GLPI_API_URL}/Ticket`, { input: ticketInput }, {
            headers: { 'Session-Token': sessionToken, 'App-Token': GLPI_APP_TOKEN }
        });
        return data.id;
    }

    async function processAttachments(sessionToken, ticketId, ticketData) {
        const { attachments, title } = ticketData;
        if (!attachments || attachments.length === 0) return;

        for (const [index, attachment] of attachments.entries()) {
            const { mimeType, base64Content } = attachment;
            if (!mimeType.startsWith('image/')) { // Apenas anexa documentos que não são imagens
                const fileExtension = getExtensionFromMime(mimeType);
                const fileName = `anexo_${ticketId}_${index + 1}${fileExtension}`;

                const formData = new FormData();
                const uploadManifest = {
                    input: {
                        name: `Anexo ${index + 1} - ${title}`,
                        _filename: [fileName],
                        itemtype: 'Ticket',
                        items_id: ticketId
                    }
                };

                formData.append('uploadManifest', JSON.stringify(uploadManifest), { contentType: 'application/json' });
                formData.append(fileName, Buffer.from(base64Content, 'base64'), { filename: fileName, contentType: mimeType });

                await axios.post(`${GLPI_API_URL}/Document`, formData, {
                    headers: {
                        'Session-Token': sessionToken, 'App-Token': GLPI_APP_TOKEN, ...formData.getHeaders()
                    }
                });
            }
        }
    }
    
    async function submitFollowupAndAttachments(from) {
        const { sessionToken, selectedTicketId, followupText, attachments } = userStates[from];
        if (!sessionToken || !selectedTicketId) {
            await sock.sendMessage(from, { text: '⚠️ Ocorreu um erro de sessão. Por favor, comece novamente.' });
            delete userStates[from];
            return;
        }
        
        try {
            // REVERTIDO: Remove o nome do usuário do conteúdo do acompanhamento
            let followupContent = `<p>${followupText.replace(/\n/g, '<br>')}</p>`;

            const imagesContent = attachments
                .filter(att => att.mimeType.startsWith('image/'))
                .map(att => `<p><img src=\"data:${att.mimeType};base64,${att.base64Content}\" /></p>`)
                .join('');
    
            if (imagesContent) {
                followupContent += `<hr><p><b>🖼️ Imagens Anexas:</b></p>${imagesContent}`;
            }

            const followupPayload = {
                input: {
                    items_id: selectedTicketId,
                    itemtype: 'Ticket',
                    content: followupContent,
                    is_private: 0
                }
            };
            await axios.post(`${GLPI_API_URL}/TicketFollowup`, followupPayload, {
                headers: { 'Session-Token': sessionToken, 'App-Token': GLPI_APP_TOKEN }
            });

            // Envia documentos que não são imagens
            await processAttachments(sessionToken, selectedTicketId, { attachments, title: `Resposta ao chamado ${selectedTicketId}` });

            await sock.sendMessage(from, { text: `✅ Sua resposta foi adicionada ao chamado *#${selectedTicketId}* com sucesso!` });
        } catch (error) {
            console.error("❌ Erro ao enviar acompanhamento:", error.response?.data || error.message);
            await sock.sendMessage(from, { text: '⚠️ Ocorreu um erro ao enviar sua resposta.' });
        } finally {
            if (sessionToken) await closeSession(sessionToken);
            delete userStates[from];
        }
    }
}

startBot();


