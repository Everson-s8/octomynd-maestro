import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export type ValidationResult = {
  valid: boolean;
  error?: string;
};

export type TelegramBotInfo = {
  id: number;
  username: string;
  first_name: string;
};

export function validateTelegramBotToken(token: string): ValidationResult {
  const trimmed = token.trim();
  if (!trimmed) {
    return { valid: false, error: "Bot token is required." };
  }
  if (trimmed === "dummy_token_for_local_setup") {
    return { valid: false, error: "Default dummy token is not valid. Please provide a real token from @BotFather." };
  }
  // Standard Telegram bot token pattern: <bot_id>:<token_secret>
  const tokenRegex = /^\d+:[A-Za-z0-9_-]{30,}$/;
  if (!tokenRegex.test(trimmed)) {
    return {
      valid: false,
      error: "Invalid Telegram Bot Token format. Expected format like '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ'."
    };
  }
  return { valid: true };
}

export function validateTelegramUserId(userId: string): ValidationResult {
  const trimmed = userId.trim();
  if (!trimmed) {
    return { valid: true };
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      valid: false,
      error: "Invalid Telegram User ID format. User ID must contain only digits (e.g. 123456789)."
    };
  }
  return { valid: true };
}

export async function testTelegramBotToken(token: string): Promise<{
  ok: boolean;
  botInfo?: TelegramBotInfo;
  error?: string;
}> {
  const validation = validateTelegramBotToken(token);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }
  try {
    const url = `https://api.telegram.org/bot${token.trim()}/getMe`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = (await response.json()) as {
      ok: boolean;
      result?: { id: number; username?: string; first_name?: string };
      description?: string;
    };
    if (data.ok && data.result) {
      return {
        ok: true,
        botInfo: {
          id: data.result.id,
          username: data.result.username ?? "",
          first_name: data.result.first_name ?? ""
        }
      };
    }
    return {
      ok: false,
      error: data.description || "Telegram API rejected the bot token."
    };
  } catch (err) {
    return {
      ok: false,
      error: `Network request to Telegram API failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export type UpdateEnvOptions = {
  botToken: string;
  allowedUserId?: string;
  cwd?: string;
  targetFile?: string;
};

export function updateEnvTelegramConfig(options: UpdateEnvOptions): {
  success: boolean;
  envPath: string;
  created: boolean;
} {
  const cwd = options.cwd ?? process.cwd();
  const envPath = options.targetFile ?? (
    fs.existsSync(path.join(cwd, ".env.local"))
      ? path.join(cwd, ".env.local")
      : path.join(cwd, ".env")
  );

  let created = false;
  let content = "";

  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf8");
  } else {
    created = true;
    const examplePath = path.join(cwd, ".env.example");
    if (fs.existsSync(examplePath)) {
      content = fs.readFileSync(examplePath, "utf8");
    } else {
      content = [
        "TELEGRAM_BOT_TOKEN=",
        "TELEGRAM_ALLOWED_USER_ID=",
        "MAESTRO_PROJECT_NAME=octomynd-maestro",
        "MAESTRO_DB_PATH=.maestro/maestro.db"
      ].join("\n");
    }
  }

  const cleanToken = options.botToken.trim();
  const cleanUserId = options.allowedUserId ? options.allowedUserId.trim() : "";

  if (/^TELEGRAM_BOT_TOKEN=.*$/m.test(content)) {
    content = content.replace(/^TELEGRAM_BOT_TOKEN=.*$/m, `TELEGRAM_BOT_TOKEN=${cleanToken}`);
  } else {
    content += (content.endsWith("\n") || content === "" ? "" : "\n") + `TELEGRAM_BOT_TOKEN=${cleanToken}\n`;
  }

  if (/^TELEGRAM_ALLOWED_USER_ID=.*$/m.test(content)) {
    content = content.replace(/^TELEGRAM_ALLOWED_USER_ID=.*$/m, `TELEGRAM_ALLOWED_USER_ID=${cleanUserId}`);
  } else {
    content += (content.endsWith("\n") || content === "" ? "" : "\n") + `TELEGRAM_ALLOWED_USER_ID=${cleanUserId}\n`;
  }

  fs.writeFileSync(envPath, content, "utf8");
  return { success: true, envPath, created };
}

export type WizardOptions = {
  cwd?: string;
  targetFile?: string;
  skipNetworkVerification?: boolean;
};

export async function runTelegramConnectWizard(options: WizardOptions = {}): Promise<{
  success: boolean;
  botToken: string;
  allowedUserId?: string;
  botInfo?: TelegramBotInfo;
  envPath: string;
  error?: string;
}> {
  console.log("\n=======================================================");
  console.log("  Octomynd Maestro - Telegram Bot Connect Wizard");
  console.log("=======================================================\n");
  console.log("This assistant connects your Telegram bot to Maestro.\n");
  console.log("Como obter as credenciais:");
  console.log("  1. No Telegram, converse com @BotFather.");
  console.log("  2. Use /newbot ou escolha um bot existente e copie o HTTP API Token.");
    console.log("  3. To restrict the bot to yourself, message @userinfobot on Telegram and copy your numeric ID.\n");

  const rl = readline.createInterface({ input, output });

  try {
    let botToken = "";
    let botInfo: TelegramBotInfo | undefined;

    while (true) {
      const rawToken = await rl.question("1. Cole o HTTP API Token do seu Telegram Bot (@BotFather): ");
      const validation = validateTelegramBotToken(rawToken);

      if (!validation.valid) {
        console.log(`[!] Validation error: ${validation.error}\n`);
        continue;
      }

      if (!options.skipNetworkVerification) {
        console.log("[...] Verificando token com a API do Telegram...");
        const testResult = await testTelegramBotToken(rawToken);

        if (!testResult.ok) {
          console.log(`[!] Telegram connection failed: ${testResult.error}`);
          const retryChoice = await rl.question("Try another token? (y/n): ");
          if (retryChoice.toLowerCase().trim() !== "y") {
            rl.close();
            return {
              success: false,
              botToken: "",
              envPath: "",
              error: testResult.error
            };
          }
          console.log("");
          continue;
        }

        botInfo = testResult.botInfo;
        console.log(`[+] Bot verified successfully: @${botInfo?.username ?? "unknown"} (${botInfo?.first_name ?? ""})`);
      }

      botToken = rawToken.trim();
      break;
    }

    let allowedUserId = "";
    while (true) {
      const rawUserId = await rl.question("\n2. Enter your Telegram User ID for restricted access (optional; press Enter for unrestricted access): ");
      const validation = validateTelegramUserId(rawUserId);

      if (!validation.valid) {
        console.log(`[!] Validation error: ${validation.error}`);
        continue;
      }

      allowedUserId = rawUserId.trim();
      break;
    }

    rl.close();

    const updateResult = updateEnvTelegramConfig({
      botToken,
      allowedUserId,
      cwd: options.cwd,
      targetFile: options.targetFile
    });

    console.log("\n=======================================================");
    console.log("[+] Telegram bot configured successfully!");
    console.log(`    Updated file: ${updateResult.envPath}`);
    if (botInfo) {
          console.log(`    Bot connected: @${botInfo.username}`);
    }
    console.log(`    Acesso: ${allowedUserId ? `Restrito ao User ID ${allowedUserId}` : "Irrestrito"}`);
    console.log("=======================================================\n");

    return {
      success: true,
      botToken,
      allowedUserId: allowedUserId || undefined,
      botInfo,
      envPath: updateResult.envPath
    };
  } catch (err) {
    rl.close();
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[!] Assistant error: ${errorMessage}`);
    return {
      success: false,
      botToken: "",
      envPath: "",
      error: errorMessage
    };
  }
}

import { pathToFileURL } from "node:url";

// Allow direct execution from CLI
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void runTelegramConnectWizard();
}

