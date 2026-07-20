import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

/** Minimal interactive prompt helpers over readline/promises. */
export async function withPrompt<T>(fn: (io: PromptIO) => Promise<T>): Promise<T> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const io = new PromptIO(rl);
  try {
    return await fn(io);
  } finally {
    rl.close();
  }
}

export class PromptIO {
  constructor(private rl: readline.Interface) {}

  async ask(question: string, def?: string): Promise<string> {
    const suffix = def !== undefined ? ` [${def}]` : "";
    const answer = (await this.rl.question(`${question}${suffix} `)).trim();
    return answer || def || "";
  }

  async confirm(question: string, def = false): Promise<boolean> {
    const hint = def ? "Y/n" : "y/N";
    const answer = (await this.rl.question(`${question} (${hint}) `)).trim().toLowerCase();
    if (!answer) return def;
    return answer === "y" || answer === "yes";
  }

  /** Present a numbered menu and return the chosen index (0-based). */
  async choose(question: string, options: string[], def = 0): Promise<number> {
    stdout.write(`${question}\n`);
    options.forEach((o, i) => stdout.write(`  ${i + 1}) ${o}\n`));
    while (true) {
      const raw = (await this.rl.question(`Choose 1-${options.length} [${def + 1}]: `)).trim();
      if (!raw) return def;
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      stdout.write("Please enter a valid number.\n");
    }
  }
}
