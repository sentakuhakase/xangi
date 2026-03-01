import { middleware, messagingApi, WebhookEvent, TextMessage } from '@line/bot-sdk';
import express from 'express';
import type { Config } from './config.js';
import type { AgentRunner } from './agent-runner.js';
import { getSession, setSession, deleteSession } from './sessions.js';
import { processManager } from './process-manager.js';
import { formatSkillList, type Skill } from './skills.js';
import { loadSettings, formatSettings } from './settings.js';

export interface LineOptions {
  config: Config;
  agentRunner: AgentRunner;
  skills: Skill[];
  reloadSkills: () => Skill[];
}

export async function startLineBot(options: LineOptions): Promise<void> {
  const { config, agentRunner, reloadSkills } = options;
  let { skills } = options;

  if (!config.line.channelAccessToken || !config.line.channelSecret) {
    throw new Error('LINE tokens not configured');
  }

  const lineConfig = {
    channelAccessToken: config.line.channelAccessToken,
    channelSecret: config.line.channelSecret,
  };

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: config.line.channelAccessToken,
  });

  const app = express();

  // Webhook endpoint
  app.post('/webhook', middleware(lineConfig), async (req, res) => {
    const events: WebhookEvent[] = req.body.events;

    const results = await Promise.all(
      events.map(async (event) => {
        try {
          return await handleEvent(event);
        } catch (err) {
          console.error('[line] Error handling event:', err);
          return null;
        }
      })
    );

    res.json(results);
  });

  async function handleEvent(event: WebhookEvent) {
    if (event.type !== 'message' || (event.message.type !== 'text' && event.message.type !== 'image')) {
      return null;
    }

    const userId = event.source.userId;
    if (!userId) return null;

    // 許可リストチェック
    if (config.line.allowedUsers && config.line.allowedUsers.length > 0) {
      if (!config.line.allowedUsers.includes(userId)) {
        console.log(`[line] Unauthorized user: ${userId}`);
        return null;
      }
    }

    const channelId = userId; // LINEではユーザーIDをチャンネルIDとして扱う（1対1想定）

    if (event.message.type === 'text') {
      const text = event.message.text.trim();

      // 特殊コマンドの処理
      if (['!new', 'new', '/new', '!clear', 'clear', '/clear'].includes(text.toLowerCase())) {
        deleteSession(channelId);
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '🆕 新しいセッションを開始しました' }],
        });
        return;
      }

      if (['!stop', 'stop', '/stop'].includes(text.toLowerCase())) {
        const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: stopped ? '🛑 タスクを停止しました' : '実行中のタスクはありません' }],
        });
        return;
      }

      if (['/skills', '!skills'].includes(text.toLowerCase())) {
        skills = reloadSkills();
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: formatSkillList(skills) }],
        });
        return;
      }

      if (['/settings', '!settings'].includes(text.toLowerCase())) {
        const settings = loadSettings();
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: formatSettings(settings) }],
        });
        return;
      }

      // 通常のメッセージ処理
      console.log(`[line] Processing message from ${userId}: ${text.slice(0, 50)}...`);
      
      try {
        const sessionId = getSession(channelId);
        const skipPermissions = config.agent.config.skipPermissions ?? false;

        const { result, sessionId: newSessionId } = await agentRunner.run(text, {
          skipPermissions,
          sessionId,
          channelId,
        });

        setSession(channelId, newSessionId);

        // LINEのメッセージは1つ最大5000文字、1回のリプライで5つまで送信可能
        const chunks = splitText(result, 4000); // 余裕を持って4000文字
        const messages: TextMessage[] = chunks.slice(0, 5).map(chunk => ({
          type: 'text',
          text: chunk,
        }));

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: messages,
        });

      } catch (error) {
        console.error('[line] Error in agent runner:', error);
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: 'エラーが発生しました' }],
        });
      }
    } else if (event.message.type === 'image') {
      // 画像対応（将来の拡張用）
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '画像の処理は現在準備中です。テキストでお送りください。' }],
      });
    }

    return null;
  }

  function splitText(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLength) {
      chunks.push(text.slice(i, i + maxLength));
    }
    return chunks;
  }

  const port = config.line.port;
  app.listen(port, () => {
    console.log(`[line] ⚡️ LINE Webhook server is running on port ${port}`);
  });
}
