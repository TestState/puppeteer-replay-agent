import {
    AttachmentSchema,
    create,
    PayloadSchema,
    Severity,
    translationCapability,
    TranslationSessionContext,
    TranslationSessionProcessor,
    TranslationState
} from "teststate-client-node";
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
                targets: [],
                value: "",
                comment: ""
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
                    targets: [],
                    value: "",
                    comment: ""
                });
            }
        } else if ("frame" in step) {
            // Reset to top frame if the step is on main but previously was in a frame
            // Note: This logic is simplified; a real tracker would be better
            commands.push({
                id: crypto.randomUUID(),
                command: "select frame",
                target: "relative=top",
                targets: [],
                value: "",
                comment: ""
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
                    targets: [],
                    value: "",
                    comment: ""
                }];

            case StepType.Click: {
                const { target, targets } = this.translateSelectors(step.selectors);
                return [{
                    id: crypto.randomUUID(),
                    command: "click",
                    target,
                    targets,
                    value: step.button === "secondary" ? "button=2" : "",
                    comment: ""
                }];
            }

            case StepType.DoubleClick: {
                const { target, targets } = this.translateSelectors(step.selectors);
                return [{
                    id: crypto.randomUUID(),
                    command: "doubleClick",
                    target,
                    targets,
                    value: "",
                    comment: ""
                }];
            }

            case StepType.Hover: {
                const { target, targets } = this.translateSelectors(step.selectors);
                return [{
                    id: crypto.randomUUID(),
                    command: "mouseOver",
                    target,
                    targets,
                    value: "",
                    comment: ""
                }];
            }

            case StepType.Change: {
                const { target, targets } = this.translateSelectors(step.selectors);
                return [{
                    id: crypto.randomUUID(),
                    command: "type",
                    target,
                    targets,
                    value: step.value,
                    comment: ""
                }];
            }

            case StepType.SetViewport:
                return [{
                    id: crypto.randomUUID(),
                    command: "setWindowSize",
                    target: `${step.width}x${step.height}`,
                    targets: [],
                    value: "",
                    comment: ""
                }];

            case StepType.WaitForElement: {
                const { target, targets } = this.translateSelectors(step.selectors);
                return [{
                    id: crypto.randomUUID(),
                    command: "waitForElementPresent",
                    target,
                    targets,
                    value: String(step.timeout || 30000),
                    comment: ""
                }];
            }

            case StepType.WaitForExpression:
                return [{
                    id: crypto.randomUUID(),
                    command: "waitForCondition",
                    target: step.expression,
                    targets: [],
                    value: String(step.timeout || 30000),
                    comment: ""
                }];

            case StepType.Scroll: {
                if ("selectors" in step) {
                    const { target, targets } = this.translateSelectors((step as any).selectors);
                    const script = target.startsWith("xpath=")
                        ? `document.evaluate("${target.substring(6)}", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.scrollIntoView()`
                        : `document.querySelector("${target.startsWith("css=") ? target.substring(4) : target}").scrollIntoView()`;
                    return [{
                        id: crypto.randomUUID(),
                        command: "runScript",
                        target: script,
                        targets: [],
                        value: "",
                        comment: ""
                    }];
                }
                return [{
                    id: crypto.randomUUID(),
                    command: "runScript",
                    target: `window.scrollTo(${step.x || 0}, ${step.y || 0})`,
                    targets: [],
                    value: "",
                    comment: ""
                }];
            }

            case StepType.Close:
                return [{
                    id: crypto.randomUUID(),
                    command: "close",
                    target: "",
                    targets: [],
                    value: "",
                    comment: ""
                }];

            case StepType.KeyDown:
            case StepType.KeyUp: {
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
                    const { target, targets } = ("selectors" in step) 
                        ? this.translateSelectors((step as any).selectors) 
                        : { target: "xpath=//body", targets: [["xpath=//body", "xpath"]] as [string, string][] };
                    return [{
                        id: crypto.randomUUID(),
                        command: "sendKeys",
                        target,
                        targets,
                        value: mappedKey,
                        comment: ""
                    }];
                }
                return null;
            }

            case StepType.CustomStep:
                return [{
                    id: crypto.randomUUID(),
                    command: "echo",
                    target: `Custom Step: ${step.name}`,
                    targets: [],
                    value: "",
                    comment: ""
                }];

            default:
                return null;
        }
    }

    private translateSelectors(selectors: any): { target: string; targets: [string, string][] } {
        if (!selectors || selectors.length === 0) {
            return { target: "xpath=//body", targets: [["xpath=//body", "xpath"]] };
        }

        const allSelectors = Array.isArray(selectors) ? selectors : [selectors];
        const targets: [string, string][] = [];

        for (const s of allSelectors) {
            const part = Array.isArray(s) ? s[s.length - 1] : s;
            if (typeof part !== "string") continue;

            let locator = "";
            let strategy = "css";

            if (part.startsWith("#") && !part.includes(" ") && !part.includes(".") && !part.includes("[") && !part.includes(">")) {
                locator = `id=${part.substring(1)}`;
                strategy = "id";
            } else if (part.startsWith("aria/") || part.startsWith("text/")) {
                const label = part.replace(/^(aria|text)\//, "");
                locator = `xpath=//*[contains(text(), '${label}')]`;
                strategy = "xpath";
            } else if (part.startsWith("xpath/")) {
                locator = `xpath=${part.substring(6)}`;
                strategy = "xpath";
            } else if (part.startsWith("css/")) {
                locator = `css=${part.substring(4)}`;
                strategy = "css";
            } else {
                locator = `css=${part}`;
                strategy = "css";
            }

            targets.push([locator, strategy]);
        }

        if (targets.length === 0) {
            return { target: "xpath=//body", targets: [["xpath=//body", "xpath"]] };
        }

        return { target: targets[0][0], targets };
    }
}
