import {Agent} from "testgenesis-client-node";
import {parseArgs} from "node:util";
import {PuppeteerReplayTestProcessor} from "./processor.js";
import {PuppeteerToSideTranslationProcessor} from "./translation-processor.js";

/**
 * Encapsulates the application configuration from CLI arguments
 * and environment variables.
 */
const {values} = parseArgs({
    args: process.argv.slice(2),
    options: {
        name: {type: "string", short: "n"},
        url: {type: "string", short: "u"},
    },
});

const CONFIG = {
    HUB_URL: values.url || process.env.HUB_URL || "http://localhost:9000",
    CLIENT_NAME: values.name || process.env.CLIENT_NAME || "puppeteer-replay-agent-" + Math.random().toString(36).substring(7),
};

console.log(`[puppeteer-replay-agent] Hub: ${CONFIG.HUB_URL}`);
console.log(`[puppeteer-replay-agent] Name: ${CONFIG.CLIENT_NAME}`);

async function main() {
    const agent = new Agent({
        hubUrl: CONFIG.HUB_URL,
        displayName: CONFIG.CLIENT_NAME,
    });

    // Register Processors
    agent.registerTestProcessor(new PuppeteerReplayTestProcessor());
    agent.registerTranslationProcessor(new PuppeteerToSideTranslationProcessor());

    // Handle Shutdown
    async function shutdown() {
        console.log("\n[Shutdown] Cleaning up...");
        agent.shutdown();
        setTimeout(() => process.exit(0), 1000);
    }

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Start Agent
    await agent.start();
}

main().catch(console.error);
