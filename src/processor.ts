import {
    create,
    testCapability,
    TestSessionContext,
    TestSessionProcessor,
    TestState,
    timestampNow,
    timestampFromDate,
    msToDuration,
    cleanObject,
    Severity,
    StepReport,
    StepReportSchema,
    StepStatus,
    SummarySchema,
    Attachment,
    AttachmentSchema
} from "testgenesis-client-node";

import puppeteer from "puppeteer";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import {createRunner, parse, PuppeteerRunnerExtension, Step, UserFlow} from "@puppeteer/replay";

class TestGenesisRunnerExtension extends PuppeteerRunnerExtension {
    public reports: StepReport[] = [];
    public attachments: Attachment[] = [];
    public stepStartTime: number = 0;
    public currentStep?: Step;

    constructor(
        private browserObj: puppeteer.Browser,
        private pageObj: puppeteer.Page,
        private context: TestSessionContext,
        private takeScreenshot: boolean = false,
        private screenshotOptions: puppeteer.ScreenshotOptions = {
            type: "jpeg",
            quality: 80,
            optimizeForSpeed: true
        }
    ) {
        super(browserObj, pageObj);
    }

    public getStepDetail(step: Step): string {
        const parts: string[] = [step.type];
        if ("url" in step) parts.push(`(${step.url})`);
        if ("selector" in step) {
            const selector = Array.isArray(step.selector) ? step.selector[0] : step.selector;
            parts.push(`on ${selector}`);
        }
        if ("value" in step) parts.push(`with "${step.value}"`);
        return parts.join(" ");
    }

    async beforeEachStep(step: Step, flow: UserFlow) {
        if (super.beforeEachStep) await super.beforeEachStep(step, flow);
        this.currentStep = step;
        this.stepStartTime = Date.now();
        const detail = this.getStepDetail(step);
        await this.context.sendTelemetry(`[Step Start] ${detail}`, Severity.INFO);
    }

    public getMimeType(type?: string): string {
        switch (type) {
            case "jpeg": return "image/jpeg";
            case "webp": return "image/webp";
            case "png": return "image/png";
            default: return "image/png";
        }
    }

    async afterEachStep(step: Step, flow: UserFlow) {
        if (super.afterEachStep) await super.afterEachStep(step, flow);
        const duration = Date.now() - this.stepStartTime;
        const detail = this.getStepDetail(step);

        let screenshotName: string | undefined;
        if (this.takeScreenshot) {
            try {
                const screenshotData = await this.pageObj.screenshot(this.screenshotOptions);
                const ext = this.screenshotOptions.type || "png";
                screenshotName = `screenshot-${this.reports.length + 1}.${ext}`;
                this.attachments.push(create(AttachmentSchema, {
                    name: screenshotName,
                    mimeType: this.getMimeType(this.screenshotOptions.type),
                    data: screenshotData as Uint8Array
                }));
            } catch (e) {
                await this.context.sendTelemetry(`Failed to take step screenshot: ${e}`, Severity.WARN);
            }
        }

        const report = create(StepReportSchema, {
            name: detail,
            status: StepStatus.PASSED,
            summary: create(SummarySchema, {
                startTime: timestampFromDate(new Date(this.stepStartTime)),
                totalDuration: msToDuration(duration),
                metadata: cleanObject({
                    step: step,
                    screenshot: screenshotName
                })
            })
        });

        this.reports.push(report);
        await this.context.sendTelemetry(`[Step End] ${step.type} complete (${duration}ms).`, Severity.INFO);
    }
}

export class PuppeteerReplayTestProcessor implements TestSessionProcessor {
    public getCapability() {
        return testCapability({
            type: "puppeteer-replay",
            payloads: [
                {type: "chrome-devtools-recorder", isRequired: true, acceptedMimeTypes: ["application/json"]},
                {type: "puppeteer-config", isRequired: false, acceptedMimeTypes: ["application/json"]}
            ]
        });
    }

    public async process(sessionId: string, context: TestSessionContext) {
        console.log(`[PuppeteerReplay] Processing session: ${sessionId}`);

        // 1. Initial Status
        await context.sendStatus({
            state: TestState.ACKNOWLEDGED,
            message: "Extracting recording..."
        });

        const startTime = new Date();
        let browser: puppeteer.Browser | null = null;
        let extension: TestGenesisRunnerExtension | undefined;
        let recordingTitle = "Unknown";
        let takeScreenshot = false;
        let screenshotOptions: puppeteer.ScreenshotOptions = {
            type: "jpeg",
            quality: 80,
            optimizeForSpeed: true
        };
        let userPrefs: any = {};
        let mergedPrefs: any = {};

        let launchOptions: any = {
            headless: true,
            args: []
        };

        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "puppeteer-profile-"));
        launchOptions.userDataDir = userDataDir;

        try {
            // 2. Extract Recording
            const payload = context.init.payloads.find(p => p.type === "chrome-devtools-recorder");
            if (!payload) {
                throw new Error("Missing 'chrome-devtools-recorder' payload.");
            }
            if (!payload.attachment) {
                throw new Error("Payload 'chrome-devtools-recorder' is missing an attachment.");
            }

            const recordingText = new TextDecoder().decode(payload.attachment.data);
            const recordingJson = JSON.parse(recordingText);
            const recording = parse(recordingJson);
            recordingTitle = recording.title;

            // 3. Extract Config
            const configPayload = context.init.payloads.find(p => p.type === "puppeteer-config");
            if (configPayload?.attachment) {
                try {
                    const configText = new TextDecoder().decode(configPayload.attachment.data);
                    const config = JSON.parse(configText);
                    
                    if (config.headless !== undefined) launchOptions.headless = config.headless;
                    if (config.product) launchOptions.product = config.product;
                    if (Array.isArray(config.args)) {
                        launchOptions.args = [...launchOptions.args, ...config.args];
                    }
                    if (config.takeScreenshot !== undefined) {
                        takeScreenshot = config.takeScreenshot;
                    }
                    if (config.screenshotConfig) {
                        screenshotOptions = { ...screenshotOptions, ...config.screenshotConfig };
                    }
                    if (config.prefs) {
                        userPrefs = config.prefs;
                    }
                } catch (e) {
                    await context.sendTelemetry(`Failed to parse puppeteer-config: ${e}`, Severity.WARN);
                }
            }

            // 4. Pre-configure Preferences
            const defaultDir = path.join(userDataDir, "Default");
            fs.mkdirSync(defaultDir, { recursive: true });

            mergedPrefs = {
                profile: {
                    password_manager_leak_detection: false,
                    password_manager_enabled: false,
                    password_manager_leak_detection_enabled: false,
                    ...userPrefs.profile
                },
                credentials_enable_service: false,
                ...userPrefs
            };
            fs.writeFileSync(path.join(defaultDir, "Preferences"), JSON.stringify(mergedPrefs));

            await context.sendStatus({
                state: TestState.RUNNING,
                message: "Launching browser and starting replay..."
            });

            browser = await puppeteer.launch(launchOptions);
            const page = await browser.newPage();
            extension = new TestGenesisRunnerExtension(browser, page, context, takeScreenshot, screenshotOptions);
            const runner = await createRunner(recording, extension);

            const browserVersion = await browser.version();

            await context.sendTelemetry(`Started Puppeteer Replay runner on ${browserVersion}.`, Severity.INFO);
            await runner.run();
            await context.sendTelemetry("Puppeteer Replay runner finished successfully.", Severity.INFO);

            // Capture final screenshot
            if (takeScreenshot) {
                try {
                    const finalScreenshot = await page.screenshot(screenshotOptions);
                    const ext = screenshotOptions.type || "png";
                    extension.attachments.push(create(AttachmentSchema, {
                        name: `final-screenshot.${ext}`,
                        mimeType: extension.getMimeType(screenshotOptions.type),
                        data: finalScreenshot as Uint8Array
                    }));
                } catch (e) {
                    await context.sendTelemetry(`Failed to take final screenshot: ${e}`, Severity.WARN);
                }
            }

            const endTime = new Date();
            const duration = endTime.getTime() - startTime.getTime();

            // 4. Send Result
            await context.sendResult({
                status: {
                    state: TestState.COMPLETED,
                    message: "Replay finished successfully"
                },
                reports: extension.reports,
                attachments: extension.attachments,
                summary: create(SummarySchema, {
                    startTime: timestampFromDate(startTime),
                    totalDuration: msToDuration(duration),
                    metadata: cleanObject({
                        ...this.getCommonMetadata(recordingTitle, browserVersion, launchOptions, mergedPrefs, duration, extension)
                    })
                })
            });
            await context.sendStatus({
                state: TestState.COMPLETED,
                message: "Execution cycle finished."
            });
        } catch (err: any) {
            console.error(`[PuppeteerReplay Error] ${err.message}`);
            const endTime = new Date();
            const duration = endTime.getTime() - startTime.getTime();

            // Try to add a failed report for the current step if it failed
            if (extension && extension.currentStep) {
                const lastReport = extension.reports[extension.reports.length - 1];
                const currentStepDetail = extension.getStepDetail(extension.currentStep);
                
                if (!lastReport || lastReport.name !== currentStepDetail) {
                    extension.reports.push(create(StepReportSchema, {
                        name: currentStepDetail,
                        status: StepStatus.FAILED,
                        summary: create(SummarySchema, {
                            startTime: timestampFromDate(new Date(extension.stepStartTime || Date.now())),
                            totalDuration: msToDuration(Date.now() - (extension.stepStartTime || Date.now())),
                            metadata: cleanObject({
                                step: extension.currentStep,
                                error: err.message
                            })
                        })
                    }));
                }
            }

            await context.sendResult({
                status: {
                    state: TestState.FAILED,
                    message: `Replay failed: ${err.message}`
                },
                reports: extension?.reports || [],
                attachments: extension?.attachments || [],
                summary: create(SummarySchema, {
                    startTime: timestampFromDate(startTime),
                    totalDuration: msToDuration(duration),
                    metadata: cleanObject({
                        ...this.getCommonMetadata(recordingTitle, "Unknown", launchOptions, mergedPrefs, duration, extension),
                        error: err.message,
                        stack: err.stack,
                    })
                })
            });
            await context.sendStatus({
                state: TestState.FAILED,
                message: `Execution failed: ${err.message}`
            });
        } finally {
            if (browser) {
                await browser.close().catch(e => console.error("[PuppeteerReplay] Error closing browser:", e));
            }
            if (userDataDir) {
                try {
                    fs.rmSync(userDataDir, { recursive: true, force: true });
                } catch (e) {
                    console.error("[PuppeteerReplay] Error cleaning up userDataDir:", e);
                }
            }
        }
    }

    private getCommonMetadata(recordingTitle: string, browserVersion: string, launchOptions: any, prefs: any, duration: number, extension?: TestGenesisRunnerExtension) {
        const actualArgs = (extension as any)?.browserObj?.process()?.spawnargs || launchOptions.args;
        return {
            recording_title: recordingTitle,
            total_steps: extension?.reports.length || 0,
            browser_name: launchOptions.product || "chrome",
            browser_version: browserVersion,
            headless: launchOptions.headless,
            args: actualArgs,
            prefs: prefs,
            execute_duration: duration,
            os_platform: os.platform(),
            os_release: os.release(),
            os_arch: os.arch(),
            cpu_model: os.cpus()[0]?.model,
            cpu_count: os.cpus().length,
            memory_total_gb: Math.round(os.totalmem() / (1024 ** 3))
        };
    }
}
