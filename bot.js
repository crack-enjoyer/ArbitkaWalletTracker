// bot.js
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

require('dotenv').config();

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN; // Replace with your bot token
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const DATA_FILE = path.join(__dirname, 'wallets.json');
const POLL_INTERVAL = process.env.POLL_INTERVAL; 
const MAX_SIGNATURES_PER_CHECK = process.env.MAX_SIGNATURES_PER_CHECK;
const MINIMUM_SOL_THRESHOLD = process.env.MINIMUM_SOL_THRESHOLD;
const DUST_THRESHOLD = process.env.DUST_THRESHOLD;

// Initialize bot and Solana connection
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// Global state
const userSessions = new Map();
const lastCheckedSignatures = new Map();

// Data structure for wallets
async function initDataFile() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify({}));
  }
}

async function loadWallets() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveWallets(wallets) {
  await fs.writeFile(DATA_FILE, JSON.stringify(wallets, null, 2));
}

// Utility functions
function formatSOL(lamports) {
  return (lamports / 1e9).toFixed(6);
}

function isValidSolanaAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

// Keyboard layouts
const mainMenuKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '➕ Add Wallet', callback_data: 'add_wallet' }],
      [{ text: '👁️ View Wallets', callback_data: 'view_wallets' }],
      [{ text: '❌ Remove Wallet', callback_data: 'remove_wallet' }]
    ]
  }
};

const backKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
    ]
  }
};

const welcomeMessage = `
🚀 Welcome to Arbitka Wallet Tracker!

This bot helps you monitor SOL transactions from your selected wallets. You can:

• Add multiple wallets with custom names
• Set transaction filters (amount, direction)
• Get real-time notifications
• Manage your wallet list easily

Click the buttons below to get started!
  `

// Bot commands
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, welcomeMessage, mainMenuKeyboard);
});

bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, welcomeMessage, mainMenuKeyboard);
});

// Callback query handlers
bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const userId = callbackQuery.from.id;

  try {
    await bot.answerCallbackQuery(callbackQuery.id);

    switch (data) {
      case 'back_to_menu':
        userSessions.delete(userId);
        await bot.editMessageText(welcomeMessage, {
          chat_id: chatId,
          message_id: messageId,
          ...mainMenuKeyboard
        });
        break;

      case 'add_wallet':
        await handleAddWallet(chatId, messageId, userId);
        break;

      case 'view_wallets':
        await handleViewWallets(chatId, messageId, userId);
        break;

      case 'remove_wallet':
        await handleRemoveWallet(chatId, messageId, userId);
        break;
      
      default:
        if (data.startsWith('edit_wallet_')) {
          const walletId = data.replace('edit_wallet_', '');
          await handleEditWallet(chatId, messageId, userId, walletId);
        } else if (data.startsWith('remove_wallet_')) {
          const walletId = data.replace('remove_wallet_', '');
          await handleConfirmRemove(chatId, messageId, userId, walletId);
        } else if (data.startsWith('confirm_remove_')) {
          const walletId = data.replace('confirm_remove_', '');
          await handleActualRemove(chatId, messageId, userId, walletId);
        } else if (data.startsWith('filter_')) {
          await handleFilterSelection(chatId, messageId, userId, data);
        } else if (data.startsWith('set_direction_')) {
            const parts = data.split('_');
            const direction = parts[2];
            const walletId = parts[3];

            await updateWalletFilter(userId, walletId, 'direction', direction);
            await handleEditWallet(chatId, messageId, userId, walletId);
        }
        break;
    }
  } catch (error) {
    console.error('Callback query error:', error);
    bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
  }
});

// Add wallet handler
async function handleAddWallet(chatId, messageId, userId) {
  userSessions.set(userId, { state: 'awaiting_wallet_name' });
  
  await bot.editMessageText(
    '📝 Let\'s add a new wallet to track!\n\nFirst, give this wallet a friendly name (e.g., "My Main Wallet", "Trading Account"):',
    {
      chat_id: chatId,
      message_id: messageId,
      ...backKeyboard
    }
  );
}

// View wallets handler
async function handleViewWallets(chatId, messageId, userId) {
  const wallets = await loadWallets();
  const userWallets = wallets[userId] || {};
  
  if (Object.keys(userWallets).length === 0) {
    await bot.editMessageText(
      '📭 You haven\'t added any wallets yet.\n\nClick "Add Wallet" to start tracking!',
      {
        chat_id: chatId,
        message_id: messageId,
        ...backKeyboard
      }
    );
    return;
  }

  let message = '👁️ Your Tracked Wallets:\n\n';
  const keyboard = [];

  for (const [walletId, wallet] of Object.entries(userWallets)) {
    message += `💼 **${wallet.name}**\n`;
    message += `📍 ${wallet.address}\n`;
    message += `💰 Min: ${wallet.minAmount || 0} SOL, Max: ${wallet.maxAmount || '∞'} SOL\n`;
    message += `🔄 Direction: ${wallet.direction || 'Both'}\n`;
    message += `🟢 Status: ${wallet.active ? 'Active' : 'Paused'}\n\n`;
    
    keyboard.push([{ text: `⚙️ ${wallet.name}`, callback_data: `edit_wallet_${walletId}` }]);
  }

  keyboard.push([{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]);

  await bot.editMessageText(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Remove wallet handler
async function handleRemoveWallet(chatId, messageId, userId) {
  const wallets = await loadWallets();
  const userWallets = wallets[userId] || {};
  
  if (Object.keys(userWallets).length === 0) {
    await bot.editMessageText(
      '📭 You don\'t have any wallets to remove.',
      {
        chat_id: chatId,
        message_id: messageId,
        ...backKeyboard
      }
    );
    return;
  }

  const keyboard = [];
  for (const [walletId, wallet] of Object.entries(userWallets)) {
    keyboard.push([{ text: `🗑️ Remove ${wallet.name}`, callback_data: `remove_wallet_${walletId}` }]);
  }
  keyboard.push([{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]);

  await bot.editMessageText(
    '🗑️ Select a wallet to remove:',
    {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// Edit wallet handler
async function handleEditWallet(chatId, messageId, userId, walletId) {
  const wallets = await loadWallets();
  const wallet = wallets[userId]?.[walletId];

  const direction = wallet.direction.charAt(0).toUpperCase() + wallet.direction.slice(1);
  
  if (!wallet) {
    bot.sendMessage(chatId, '❌ Wallet not found.');
    return;
  }

  const keyboard = [
    [{ text: '💰 Set Min Amount', callback_data: `filter_min_${walletId}` }],
    [{ text: '💰 Set Max Amount', callback_data: `filter_max_${walletId}` }],
    [{ text: '🔄 Change Direction', callback_data: `filter_direction_${walletId}` }],
    [{ text: wallet.active ? '⏸️ Pause Tracking' : '▶️ Resume Tracking', callback_data: `filter_toggle_${walletId}` }],
    [{ text: '🔙 Back to Wallets', callback_data: 'view_wallets' }]
  ];

  const message = `⚙️ **${wallet.name}** Settings\n\n` +
                  `📍 Address: ${wallet.address}\n` +
                  `💰 Min Amount: ${wallet.minAmount} SOL\n` +
                  `💰 Max Amount: ${wallet.maxAmount} SOL\n` +
                  `🔄 Direction: ${direction}\n` +
                  `🟢 Status: ${wallet.active}`;

  await bot.editMessageText(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Replace the entire bot.on('message', ...) handler with this fixed version
bot.on('message', async (msg) => {
  // Skip if it's a command or empty message
  if (!msg.text || msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();
  const session = userSessions.get(userId);

  if (!session) return;

  try {
    switch (session.state) {
      case 'awaiting_wallet_name':
        if (text.length > 50) {
          bot.sendMessage(chatId, '❌ Wallet name too long. Please use 50 characters or less.');
          return;
        }
        session.walletName = text;
        session.state = 'awaiting_wallet_address';
        bot.sendMessage(chatId, `Great! Now send me the Solana wallet address for "${text}":`);
        break;

      case 'awaiting_wallet_address':
        if (!isValidSolanaAddress(text)) {
          bot.sendMessage(chatId, '❌ Invalid Solana address. Please send a valid address (44 characters, base58 encoded).');
          return;
        }

        const wallets = await loadWallets();
        if (!wallets[userId]) wallets[userId] = {};

        const walletId = Date.now().toString();
        wallets[userId][walletId] = {
          name: session.walletName,
          address: text,
          minAmount: MINIMUM_SOL_THRESHOLD,
          maxAmount: null,
          direction: 'both',
          active: true,
          created: new Date().toISOString()
        };

        await saveWallets(wallets);
        userSessions.delete(userId);

        const successKeyboard = {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⚙️ Configure Filters', callback_data: `edit_wallet_${walletId}` }],
              [{ text: '🏠 Main Menu', callback_data: 'back_to_menu' }]
            ]
          }
        };

        bot.sendMessage(
          chatId, 
          `✅ Successfully added wallet "${session.walletName}"!\n\nThe wallet is now being monitored for all transactions. You can configure filters to customize notifications.`,
          successKeyboard
        );
        break;

      case 'awaiting_min_amount':
        const minAmount = parseFloat(text);
        if (isNaN(minAmount) || minAmount < MINIMUM_SOL_THRESHOLD) {
          bot.sendMessage(chatId, `❌ Minimum amount must be at least ${MINIMUM_SOL_THRESHOLD} SOL to reduce spam and API usage.`);
          return;
        }
        
        await updateWalletFilter(userId, session.walletId, 'minAmount', minAmount);
        userSessions.delete(userId);
        
        const minSuccessKeyboard = {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⚙️ Back to Wallet Settings', callback_data: `edit_wallet_${session.walletId}` }],
              [{ text: '🏠 Main Menu', callback_data: 'back_to_menu' }]
            ]
          }
        };
        bot.sendMessage(chatId, `✅ Minimum amount set to ${minAmount} SOL`, minSuccessKeyboard);
        break;

      case 'awaiting_max_amount':
        const maxAmount = parseFloat(text);
        if (isNaN(maxAmount) || maxAmount <= MINIMUM_SOL_THRESHOLD) {
          bot.sendMessage(chatId, `❌ Maximum amount must be greater than ${MINIMUM_SOL_THRESHOLD} SOL.`);
          return;
        }
        
        // Get current wallet to check min amount
        const currentWallets = await loadWallets();
        const currentWallet = currentWallets[userId]?.[session.walletId];
        if (currentWallet && maxAmount < currentWallet.minAmount) {
          bot.sendMessage(chatId, `❌ Maximum amount (${maxAmount}) must be greater than minimum amount (${currentWallet.minAmount}).`);
          return;
        }
        
        await updateWalletFilter(userId, session.walletId, 'maxAmount', maxAmount);
        userSessions.delete(userId);
        
        const maxSuccessKeyboard = {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⚙️ Back to Wallet Settings', callback_data: `edit_wallet_${session.walletId}` }],
              [{ text: '🏠 Main Menu', callback_data: 'back_to_menu' }]
            ]
          }
        };
        bot.sendMessage(chatId, `✅ Maximum amount set to ${maxAmount} SOL`, maxSuccessKeyboard);
        break;

      default:
        // If user sends a message but no session is active, ignore it
        break;
    }
  } catch (error) {
    console.error('Message handling error:', error);
    bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
    userSessions.delete(userId);
  }
});

// Filter handlers
async function handleFilterSelection(chatId, messageId, userId, data) {
  const parts = data.split('_');
  const action = parts[1];
  const walletId = parts[2];

  switch (action) {
    case 'min':
      userSessions.set(userId, { state: 'awaiting_min_amount', walletId });
      await bot.editMessageText(
        '💰 Enter the minimum transaction amount in SOL (e.g., 0.1):',
        { chat_id: chatId, message_id: messageId, ...backKeyboard }
      );
      break;

    case 'max':
      userSessions.set(userId, { state: 'awaiting_max_amount', walletId });
      await bot.editMessageText(
        '💰 Enter the maximum transaction amount in SOL (e.g., 100):',
        { chat_id: chatId, message_id: messageId, ...backKeyboard }
      );
      break;

    case 'direction':
      const directionKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📥 Incoming Only', callback_data: `set_direction_incoming_${walletId}` }],
            [{ text: '📤 Outgoing Only', callback_data: `set_direction_outgoing_${walletId}` }],
            [{ text: '🔄 Both Directions', callback_data: `set_direction_both_${walletId}` }],
            [{ text: '🔙 Back', callback_data: `edit_wallet_${walletId}` }]
          ]
        }
      };
      await bot.editMessageText(
        '🔄 Choose transaction direction to monitor:',
        { chat_id: chatId, message_id: messageId, ...directionKeyboard }
      );
      break;

    case 'toggle':
      const wallets = await loadWallets();
      const wallet = wallets[userId]?.[walletId];
      if (wallet) {
        wallet.active = !wallet.active;
        await saveWallets(wallets);
        await handleEditWallet(chatId, messageId, userId, walletId);
      }
      break;
  }

  if (data.startsWith('set_direction_')) {
    const direction = parts[2] === 'incoming';
    const walletId = parts[3];
    await updateWalletFilter(userId, walletId, 'direction', direction);
    bot.sendMessage(chatId, `✅ Direction filter set to: ${direction}`);
  }
}

// Helper functions
async function updateWalletFilter(userId, walletId, field, value) {
  const wallets = await loadWallets();
  if (wallets[userId] && wallets[userId][walletId]) {
    wallets[userId][walletId][field] = value;
    await saveWallets(wallets);
  }
}

async function handleConfirmRemove(chatId, messageId, userId, walletId) {
  const wallets = await loadWallets();
  const wallet = wallets[userId]?.[walletId];
  
  if (!wallet) return;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Yes, Remove', callback_data: `confirm_remove_${walletId}` }],
        [{ text: '❌ Cancel', callback_data: 'remove_wallet' }]
      ]
    }
  };

  await bot.editMessageText(
    `🗑️ Are you sure you want to remove "${wallet.name}"?\n\nThis action cannot be undone.`,
    { chat_id: chatId, message_id: messageId, ...keyboard }
  );
}

async function handleActualRemove(chatId, messageId, userId, walletId) {
  const wallets = await loadWallets();
  const wallet = wallets[userId]?.[walletId];
  
  if (wallet) {
    delete wallets[userId][walletId];
    await saveWallets(wallets);
    
    await bot.editMessageText(
      `✅ "${wallet.name}" has been removed from tracking.`,
      { chat_id: chatId, message_id: messageId, ...backKeyboard }
    );
  }
}

async function checkTransactions() {
  try {
    const wallets = await loadWallets();
    const activeWallets = [];
    
    // Collect all active wallets
    for (const [userId, userWallets] of Object.entries(wallets)) {
      for (const [walletId, wallet] of Object.entries(userWallets)) {
        if (wallet.active) {
          activeWallets.push({ userId, walletId, wallet });
        }
      }
    }
    
    if (activeWallets.length === 0) {
      console.log('📭 No active wallets to monitor');
      return;
    }
    
    console.log(`🔍 Checking ${activeWallets.length} active wallets...`);
    
    // Process wallets in batches to avoid rate limits
    const BATCH_SIZE = 3; // Process 3 wallets at a time
    
    for (let i = 0; i < activeWallets.length; i += BATCH_SIZE) {
      const batch = activeWallets.slice(i, i + BATCH_SIZE);
      
      // Process batch concurrently but with limited concurrency
      await Promise.all(
        batch.map(({ userId, walletId, wallet }) =>
          checkWalletTransactions(userId, walletId, wallet)
        )
      );
      
      // Delay between batches to respect rate limits
      if (i + BATCH_SIZE < activeWallets.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`✅ Completed checking ${activeWallets.length} wallets`);
    
  } catch (error) {
    console.error('❌ Batch transaction checking error:', error);
  }
}

async function checkWalletTransactions(userId, walletId, wallet) {
  try {
    const publicKey = new PublicKey(wallet.address);
    
    // Get only the latest signature for efficiency
    const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 1 });
    
    if (signatures.length === 0) return;

    const latestSignature = signatures[0].signature;
    const lastSignature = lastCheckedSignatures.get(walletId);
    
    // If this is the first check, just store and return
    if (!lastSignature) {
      lastCheckedSignatures.set(walletId, latestSignature);
      console.log(`🔍 Initialized tracking for wallet: ${wallet.name}`);
      return;
    }

    // If no new transaction, return early
    if (latestSignature === lastSignature) {
      return;
    }

    // We have a new transaction - get more details
    console.log(`🆕 New transaction detected for ${wallet.name}`);
    
    // Get up to 5 recent signatures to catch any we missed
    const recentSignatures = await connection.getSignaturesForAddress(publicKey, { limit: 5 });
    const newSignatures = [];
    
    for (const sigInfo of recentSignatures) {
      if (sigInfo.signature === lastSignature) break;
      newSignatures.push(sigInfo);
    }

    // Process new transactions (oldest first)
    for (const sigInfo of newSignatures.reverse()) {
      await processTransaction(userId, wallet, sigInfo);
      
      // Small delay between processing to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Update last checked signature
    lastCheckedSignatures.set(walletId, latestSignature);
    
  } catch (error) {
    console.error(`❌ Error checking wallet ${wallet.name}:`, error.message);
    
    // If rate limited, wait longer before next check
    if (error.message.includes('429') || error.message.includes('rate')) {
      console.log(`⏰ Rate limited, will retry later for ${wallet.name}`);
    }
  }
}

async function processTransaction(userId, wallet, sigInfo) {
  try {
    const transaction = await connection.getParsedTransaction(sigInfo.signature, 'confirmed');
    if (!transaction || !transaction.meta) return;

    const solTransfer = await analyzeSolTransaction(transaction, wallet.address);
    if (!solTransfer) return;

    if (shouldNotify(solTransfer, wallet)) {
      await sendTransactionNotification(userId, wallet, solTransfer);
      console.log(`📤 Notification sent for ${wallet.name}: ${formatSOL(solTransfer.amount)} SOL`);
    }
  } catch (error) {
    console.error(`❌ Error processing transaction:`, error.message);
  }
}

async function analyzeSolTransaction(transaction, walletAddress) {
  const preBalances = transaction.meta.preBalances;
  const postBalances = transaction.meta.postBalances;
  const accountKeys = transaction.transaction.message.accountKeys;

  let receiver_sender;

  let walletIndex = -1;
  for (let i = 0; i < accountKeys.length; i++) {
    if (accountKeys[i].pubkey.toString() === walletAddress) {
      walletIndex = i;
      break;
    }
  }

  if (walletIndex === -1) return null;

  let balanceChange = postBalances[walletIndex] - preBalances[walletIndex];
  if (Math.abs(balanceChange) < 1000) return null; // Ignore dust

  for (let i = 0; i < accountKeys.length; i++) {
      if (i !== walletIndex) {
          const senderBalanceChange = (postBalances[i] - preBalances[i]);
          // Allow for some variance due to fees
          if (balanceChange > 0 && senderBalanceChange < 0) {
            receiver_sender = accountKeys[i].pubkey.toString();
            break;
          } else if (balanceChange < 0 && senderBalanceChange > 0 && (senderBalanceChange + balanceChange) < 1000000) {
            receiver_sender = accountKeys[i].pubkey.toString();
            break;
          }
      }
  }

  return {
    signature: transaction.transaction.signatures[0],
    amount: Math.abs(balanceChange),
    direction: balanceChange > 0 ? 'incoming' : 'outgoing',
    timestamp: transaction.blockTime * 1000,
    receiver_sender: receiver_sender
  };
}

function shouldNotify(transfer, wallet) {
  const amount = transfer.amount / 1e9; // Convert to SOL
  
  // Always enforce the hardcoded minimum
  if (amount < MINIMUM_SOL_THRESHOLD) {
    console.log(`🚫 Transaction below minimum threshold: ${amount} SOL`);
    return false;
  }
  
  // Check user-defined minimum (should be >= MINIMUM_SOL_THRESHOLD)
  if (wallet.minAmount && amount < wallet.minAmount) {
    console.log(`🚫 Transaction below user minimum: ${amount} SOL < ${wallet.minAmount} SOL`);
    return false;
  }
  
  // Check maximum amount
  if (wallet.maxAmount && amount > wallet.maxAmount) {
    console.log(`🚫 Transaction above user maximum: ${amount} SOL > ${wallet.maxAmount} SOL`);
    return false;
  }
  
  // Check direction filter
  if (wallet.direction !== 'both' && wallet.direction !== transfer.direction) {
    console.log(`🚫 Transaction direction filtered: ${transfer.direction} != ${wallet.direction}`);
    return false;
  }
  
  console.log(`✅ Transaction passes all filters: ${amount} SOL (${transfer.direction})`);
  return true;
}

async function sendTransactionNotification(userId, wallet, transfer) {
  const amount = formatSOL(transfer.amount);
  const direction = transfer.direction === 'incoming' ? '📥' : '📤';
  const directionText = transfer.direction === 'incoming' ? 'received' : 'sent';
  const receiver_sender = transfer.receiver_sender;
  
  const message = `${direction} **${wallet.name}** Transaction Alert!\n\n` +
                  `💰 Amount: ${amount} SOL ${directionText}\n` +
                  `📍 ${transfer.direction === 'incoming' ? 'From: ' : 'To: '} ${receiver_sender}\n` +
                  `🕐 Time: ${new Date(transfer.timestamp).toLocaleString()}\n`

  const keyboard = {
      reply_markup: {
          inline_keyboard: [
              [
                  { text: "🔗 View TX", url: `https://solscan.io/tx/${transfer.signature}` },
                  { text: "👤 View Sender", url: `https://solscan.io/account/${transfer.receiver_sender}` }
              ]
          ]
      }
  };

  try {
    await bot.sendMessage(userId, message, { parse_mode: 'Markdown', disable_web_page_preview: true, ...keyboard });
  } catch (error) {
    console.error(`Failed to send notification to user ${userId}:`, error);
  }
}

// Initialize and start
async function start() {
  console.log('🚀 Starting Solana Wallet Tracker Bot...');
  
  await initDataFile();
  
  setInterval(checkTransactions, 15000);
  
  console.log('✅ Bot is running and monitoring transactions!');
  console.log('📱 Send /start to your bot to begin tracking wallets.');
}

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

// Start the bot
start();