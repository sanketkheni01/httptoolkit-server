import * as _ from 'lodash';
import { spawn } from 'child_process';
import * as util from 'util';
import * as fs from 'fs';

import { getPortPromise as getPort } from 'portfinder';
import { generateSPKIFingerprint } from 'mockttp';
import ChromeRemoteInterface = require('chrome-remote-interface');

import { Interceptor } from '.';

import { HtkConfig } from '../config';
import { delay } from '../util';
import { getTerminalEnvVars } from './terminal/terminal-env-overrides';

const readFile = util.promisify(fs.readFile);

export class ElectronInterceptor implements Interceptor {
    readonly id = 'electron';
    readonly version = '1.0.0';

    private debugClients: {
        [port: string]: Array<ChromeRemoteInterface.CdpClient>
     } = {};

    constructor(private config: HtkConfig) { }

    private certData = readFile(this.config.https.certPath, 'utf8')

    async isActivable(): Promise<boolean> {
        return true;
    }

    isActive(proxyPort: number | string) {
        return !!this.debugClients[proxyPort] &&
            !!this.debugClients[proxyPort].length;
    }

    async activate(proxyPort: number, options: {
        pathToApplication: string
    }): Promise<void | {}> {
        const debugPort = await getPort({ port: proxyPort });

        spawn(options.pathToApplication, [`--inspect-brk=${debugPort}`], {
            stdio: 'inherit',
            env: Object.assign({},
                process.env,
                getTerminalEnvVars(proxyPort, this.config.https, process.env)
            )
        });

        let debugClient: ChromeRemoteInterface.CdpClient | undefined;
        let retries = 10;
        while (!debugClient && retries >= 0) {
            try {
                debugClient = await ChromeRemoteInterface({ port: debugPort });
            } catch (error) {
                if (error.code !== 'ECONNREFUSED' || retries === 0) {
                    throw error;
                }

                retries = retries - 1;
                await delay(500);
            }
        }
        if (!debugClient) throw new Error('Could not initialize CDP client');

        this.debugClients[proxyPort] = this.debugClients[proxyPort] || [];
        this.debugClients[proxyPort].push(debugClient);

        const callFramePromise = new Promise<string>((resolve) => {
            debugClient!.Debugger.paused((stack) => {
                resolve(stack.callFrames[0].callFrameId);
            });
        });

        debugClient.Runtime.runIfWaitingForDebugger();
        await debugClient.Runtime.enable();
        await debugClient.Debugger.enable();

        const callFrameId = await callFramePromise;

        // Patch in our various module overrides:
        await debugClient.Debugger.evaluateOnCallFrame({
            expression: `require("${
                // Inside the Electron process, load our electron-intercepting JS
                require.resolve('../../overrides/js/prepend-electron.js')
            }")({
                newlineEncodedCertData: "${(await this.certData).replace(/\r\n|\r|\n/g, '\\n')}",
                spkiFingerprint: "${generateSPKIFingerprint(await this.certData)}"
            })`,
            callFrameId
        });

        debugClient.Debugger.resume();
        debugClient.once('disconnect', () => {
            _.remove(this.debugClients[proxyPort], c => c === debugClient);
        });
    }

    async deactivate(proxyPort: number | string): Promise<void> {
        if (!this.isActive(proxyPort)) return;

        await Promise.all(
            this.debugClients[proxyPort].map(async (debugClient) => {
                // Politely signal self to shutdown cleanly
                await debugClient.Runtime.evaluate({
                    expression: 'process.kill(process.pid, "SIGTERM")'
                });

                // Wait up to 1s for a clean shutdown & disconnect
                const cleanShutdown = await Promise.race([
                    new Promise((resolve) =>
                        debugClient.once('disconnect', () => resolve(true))
                    ),
                    delay(1000).then(() => false)
                ]);

                if (!cleanShutdown) {
                    // Didn't shutdown? Inject a hard exit.
                    await debugClient.Runtime.evaluate({
                        expression: 'process.exit(0)'
                    }).catch(() => {}) // Ignore errors (there's an inherent race here)
                };
            })
        );
    }

    async deactivateAll(): Promise<void> {
        await Promise.all<void>(
            Object.keys(this.debugClients).map(port => this.deactivate(port))
        );
    }

}