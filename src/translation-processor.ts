import {
    AttachmentSchema,
    create,
    PayloadSchema,
    Severity,
    translationCapability,
    TranslationSessionContext,
    TranslationSessionProcessor,
    TranslationState
} from "testgenesis-client-node";
import * as crypto from "crypto";
import {Step, StepType, UserFlow} from "@puppeteer/replay";
import type {CommandShape, TestShape} from "@seleniumhq/side-model";

/**
 * Translates Puppeteer Replay recordings (chrome-devtools-recorder)
 * to Selenium IDE project tests (selenium-side).
 */
export class PuppeteerToSideTranslationProcessor implements TranslationSessionProcessor {
    public getCapability() {
        return translationCapability({
            type: "puppeteer-replay-to-selenium-side",
            sourcePayloads: [{
                type: "chrome-devtools-recorder",
                isRequired: true,
                acceptedMimeTypes: ["application/json"]
            }],
            targetPayloads: [{
                type: "selenium-side",
                isRequired: true,
                acceptedMimeTypes: ["application/json"]
            }]
        });
    }

    public async process(sessionId: string, context: TranslationSessionContext) {
        try {
            await context.sendStatus({
                state: TranslationState.ACKNOWLEDGED,
                message: "Starting Puppeteer-to-SIDE translation..."
            });

            const sourcePayload = context.init.payloads[0];
            if (!sourcePayload?.attachment) {
                await context.sendStatus({
                    state: TranslationState.FAILED,
                    message: "No source recording attachment found"
                });
                return;
            }

            const recording: UserFlow = JSON.parse(new TextDecoder().decode(sourcePayload.attachment.data));
            await context.sendTelemetry(`Translating recording: ${recording.title}`);

            const sideCommands: CommandShape[] = [];

            for (const step of recording.steps) {
                // Pre-step: Handle Frame/Window Context
                this.appendContextCommands(sideCommands, step);

                const translated = this.translateStep(step);
                if (translated) {
                    sideCommands.push(...translated);
                }
            }

            const test: TestShape = {
                id: crypto.randomUUID(),
                name: recording.title || "Puppeteer Translation",
                commands: sideCommands
            };

            await context.sendResult({
                status: {state: TranslationState.COMPLETED},
                payloads: [
                    create(PayloadSchema, {
                        type: "selenium-side",
                        attachment: create(AttachmentSchema, {
                            name: `${test.name}.json`,
                            mimeType: "application/json",
                            data: new TextEncoder().encode(JSON.stringify(test))
                        })
                    })
                ]
            });

            await context.sendStatus({
                state: TranslationState.COMPLETED,
                message: `Successfully translated ${recording.steps.length} steps to ${sideCommands.length} SIDE commands.`
            });

        } catch (err: any) {
            console.error(`[Translate ${sessionId}] Error:`, err);
            await context.sendStatus({
                state: TranslationState.FAILED,
                message: `Translation Error: ${err.message}`
            });
        }
    }

    private currentTarget = "main";

    private appendContextCommands(commands: CommandShape[], step: Step) {
        // Handle Target (Tabs/Windows)
        if ("target" in step && step.target && step.target !== this.currentTarget) {
            commands.push({
                id: crypto.randomUUID(),
                command: "select window",
                target: `handle=${step.target}`,
                value: ""
            });
            this.currentTarget = step.target;
        }

        // Handle Frame Selectors
        if ("frame" in step && Array.isArray(step.frame) && step.frame.length > 0) {
            for (const frameIndex of step.frame) {
                commands.push({
                    id: crypto.randomUUID(),
                    command: "select frame",
                    target: `index=${frameIndex}`,
                    value: ""
                });
            }
        } else if ("frame" in step) {
            // Reset to top frame if the step is on main but previously was in a frame
            // Note: This logic is simplified; a real tracker would be better
            commands.push({
                id: crypto.randomUUID(),
                command: "select frame",
                target: "relative=top",
                value: ""
            });
        }
    }

    private translateStep(step: Step): CommandShape[] | null {
        switch (step.type) {
            case StepType.Navigate:
                return [{
                    id: crypto.randomUUID(),
                    command: "open",
                    target: step.url,
                    value: ""
                }];

            case StepType.Click:
                return [{
                    id: crypto.randomUUID(),
                    command: "click",
                    target: this.translateSelector(step.selectors),
                    value: step.button === "secondary" ? "button=2" : ""
                }];

            case StepType.DoubleClick:
                return [{
                    id: crypto.randomUUID(),
                    command: "doubleClick",
                    target: this.translateSelector(step.selectors),
                    value: ""
                }];

            case StepType.Hover:
                return [{
                    id: crypto.randomUUID(),
                    command: "mouseOver",
                    target: this.translateSelector(step.selectors),
                    value: ""
                }];

            case StepType.Change:
                return [{
                    id: crypto.randomUUID(),
                    command: "type",
                    target: this.translateSelector(step.selectors),
                    value: step.value
                }];

            case StepType.SetViewport:
                return [{
                    id: crypto.randomUUID(),
                    command: "setWindowSize",
                    target: `${step.width}x${step.height}`,
                    value: ""
                }];

            case StepType.WaitForElement:
                return [{
                    id: crypto.randomUUID(),
                    command: "waitForElementPresent",
                    target: this.translateSelector(step.selectors),
                    value: String(step.timeout || 30000)
                }];

            case StepType.WaitForExpression:
                return [{
                    id: crypto.randomUUID(),
                    command: "waitForCondition",
                    target: step.expression,
                    value: String(step.timeout || 30000)
                }];

            case StepType.Scroll:
                if ("selectors" in step) {
                    const locator = this.translateSelector((step as any).selectors);
                    const script = locator.startsWith("xpath=")
                        ? `document.evaluate("${locator.substring(6)}", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.scrollIntoView()`
                        : `document.querySelector("${locator.substring(4)}").scrollIntoView()`;
                    return [{
                        id: crypto.randomUUID(),
                        command: "runScript",
                        target: script,
                        value: ""
                    }];
                }
                return [{
                    id: crypto.randomUUID(),
                    command: "runScript",
                    target: `window.scrollTo(${step.x || 0}, ${step.y || 0})`,
                    value: ""
                }];

            case StepType.Close:
                return [{
                    id: crypto.randomUUID(),
                    command: "close",
                    target: "",
                    value: ""
                }];

            case StepType.KeyDown:
            case StepType.KeyUp:
                const keyMap: Record<string, string> = {
                    "Enter": "${KEY_ENTER}",
                    "Tab": "${KEY_TAB}",
                    "Escape": "${KEY_ESC}",
                    "Backspace": "${KEY_BACKSPACE}",
                    "Delete": "${KEY_DELETE}",
                    "ArrowUp": "${KEY_UP}",
                    "ArrowDown": "${KEY_DOWN}",
                    "ArrowLeft": "${KEY_LEFT}",
                    "ArrowRight": "${KEY_RIGHT}",
                    "Home": "${KEY_HOME}",
                    "End": "${KEY_END}",
                    "PageUp": "${KEY_PAGE_UP}",
                    "PageDown": "${KEY_PAGE_DOWN}",
                    "Insert": "${KEY_INSERT}",
                    "Shift": "${KEY_SHIFT}",
                    "Control": "${KEY_CONTROL}",
                    "Alt": "${KEY_ALT}",
                    "Meta": "${KEY_META}",
                    "F1": "${KEY_F1}",
                    "F2": "${KEY_F2}",
                    "F3": "${KEY_F3}",
                    "F4": "${KEY_F4}",
                    "F5": "${KEY_F5}",
                    "F6": "${KEY_F6}",
                    "F7": "${KEY_F7}",
                    "F8": "${KEY_F8}",
                    "F9": "${KEY_F9}",
                    "F10": "${KEY_F10}",
                    "F11": "${KEY_F11}",
                    "F12": "${KEY_F12}"
                };

                const mappedKey = keyMap[step.key] || (step.key.length === 1 ? step.key : null);
                
                if (mappedKey) {
                    const target = ("selectors" in step) 
                        ? this.translateSelector((step as any).selectors) 
                        : "xpath=//body";
                    return [{
                        id: crypto.randomUUID(),
                        command: "sendKeys",
                        target,
                        value: mappedKey
                    }];
                }
                return null;

            case StepType.CustomStep:
                return [{
                    id: crypto.randomUUID(),
                    command: "echo",
                    target: `Custom Step: ${step.name}`,
                    value: ""
                }];

            default:
                return null;
        }
    }

    private translateSelector(selectors: any): string {
        if (!selectors || selectors.length === 0) return "document";

        const allSelectors = Array.isArray(selectors) ? selectors : [selectors];
        
        // Tier 1: Look for simple ID selectors (safest)
        for (const s of allSelectors) {
            const part = Array.isArray(s) ? s[s.length - 1] : s;
            if (part.startsWith("#") && !part.includes(" ") && !part.includes(".") && !part.includes("[") && !part.includes(">")) {
                return `css=${part}`;
            }
        }

        // Tier 2: ARIA / Text (high compatibility)
        for (const s of allSelectors) {
            const part = Array.isArray(s) ? s[s.length - 1] : s;
            if (part.startsWith("aria/") || part.startsWith("text/")) {
                const label = part.replace(/^(aria|text)\//, "");
                return `xpath=//*[contains(text(), '${label}')]`;
            }
        }

        // Tier 3: XPath (precise)
        for (const s of allSelectors) {
            const part = Array.isArray(s) ? s[s.length - 1] : s;
            if (part.startsWith("xpath/")) {
                return `xpath=${part.substring(6)}`;
            }
        }

        // Tier 4: CSS / Pierce
        for (const s of allSelectors) {
            const part = Array.isArray(s) ? s[s.length - 1] : s;
            if (part.startsWith("css/")) {
                return `css=${part.substring(4)}`;
            }
            if (!part.includes("/") && !part.startsWith("pierce/")) {
                return `css=${part}`;
            }
        }
        
        // Final Fallback: Literal first selector
        const first = Array.isArray(allSelectors[0]) ? allSelectors[0][allSelectors[0].length - 1] : allSelectors[0];
        return `css=${first.replace(/^(css|xpath|aria|text)\//, "")}`;
    }
}
