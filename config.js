// === ARQUIVO DE CONFIGURAÇÃO - WHATSAPP GLPI BOT ===
// Altere os valores abaixo com as informações do seu ambiente.

const config = {
    // --- Configurações da API do GLPI ---
    GLPI_API_URL: "http://seu-servidor-glpi.com/apirest.php", // URL da sua API REST do GLPI
    GLPI_APP_TOKEN: "SEU_APP_TOKEN",                        // Token de Aplicativo gerado no GLPI
    GLPI_USER_TOKEN: "SEU_USER_TOKEN",                       // Token de Usuário para autenticação

    // --- Configurações do Bot ---
    INACTIVITY_MINUTES: 5,                                 // Tempo em minutos para encerrar a sessão por inatividade
    USER_EMAILS_PATH: './user_emails.json',                // Arquivo para salvar os e-mails dos usuários
    DEBUG_MODE: false,                                     // Mude para true para ver logs detalhados no console
    TITLE_MAX_CHARS: 70,                                   // Número máximo de caracteres para o título do chamado
    DESCRIPTION_MIN_CHARS: 20,                             // Número mínimo de caracteres para a descrição
    KNOWLEDGE_BASE_URL: "http://sua-base-de-conhecimento.com", // Link para o site de procedimentos/FAQ

    // --- Configurações do Webhook (Opcional) ---
    WEBHOOK_PORT: 3000,                                    // Porta para o servidor de webhook escutar as notificações do GLPI
    BOT_INITIATED_UPDATE_COOLDOWN_MS: 30 * 1000,           // (Avançado) Cooldown para evitar eco de webhooks após ação do bot
    WEBHOOK_PROCESSING_DELAY_MS: 7 * 1000,                 // (Avançado) Atraso para processar webhooks

    // --- Mapeamento de Categorias do GLPI ---
    // IMPORTANTE: Você PRECISA ajustar os IDs (números) para corresponderem às categorias do SEU GLPI.
    CATEGORIES_DISPLAY: {
        '1': '🖥️ Problemas de Software',
        '2': '📧 E-mail & Contas',
        '3': '🌐 Rede e Internet',
        '4': '📠 Impressoras',
        '5': '💻 Hardware (Computadores e Notebooks)',
        '6': '📱 Dispositivos Móveis',
        '7': '🔑 Gestão de Acessos',
        '8': '❓ Dúvida Geral',
        '9': '💡 Outros'
    },
    CATEGORIES_API_MAP: {
        '🖥️ Problemas de Software': 1, // Ex: ID da categoria "Software" no seu GLPI
        '📧 E-mail & Contas': 2,        // Ex: ID da categoria "E-mail" no seu GLPI
        '🌐 Rede e Internet': 3,       // Ex: ID da categoria "Rede" no seu GLPI
        '📠 Impressoras': 4,            // Ex: ID da categoria "Impressoras" no seu GLPI
        '💻 Hardware (Computadores e Notebooks)': 5, // Ex: ID da categoria "Hardware" no seu GLPI
        '📱 Dispositivos Móveis': 6,    // Ex: ID da categoria "Celulares" no seu GLPI
        '🔑 Gestão de Acessos': 7,      // Ex: ID da categoria "Acessos" no seu GLPI
        '❓ Dúvida Geral': 8,           // Ex: ID da categoria "Dúvida" no seu GLPI
        '💡 Outros': 9                 // Ex: ID da categoria "Outros" no seu GLPI
    },

    // --- Mapeamento de Status do GLPI (Geralmente não precisa alterar) ---
    GLPI_STATUS_MAP: {
        1: 'Novo',
        2: 'Em atendimento (atribuído)',
        3: 'Em atendimento (planejado)',
        4: 'Pendente',
        5: 'Solucionado',
        6: 'Fechado'
    }
};

module.exports = config;
