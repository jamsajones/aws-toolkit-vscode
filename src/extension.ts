/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

import * as vscode from 'vscode'
import * as nls from 'vscode-nls'

import { resumeCreateNewSamApp } from './lambda/commands/createNewSamApp'
import { RegionNode } from './lambda/explorer/regionNode'
import { LambdaTreeDataProvider } from './lambda/lambdaTreeDataProvider'
import { DefaultAWSClientBuilder } from './shared/awsClientBuilder'
import { AwsContextTreeCollection } from './shared/awsContextTreeCollection'
import { DefaultToolkitClientBuilder } from './shared/clients/defaultToolkitClientBuilder'
import { TypescriptCodeLensProvider } from './shared/codelens/typescriptCodeLensProvider'
import { documentationUrl, extensionSettingsPrefix, githubUrl } from './shared/constants'
import { DefaultCredentialsFileReaderWriter } from './shared/credentials/defaultCredentialsFileReaderWriter'
import { DefaultAwsContext } from './shared/defaultAwsContext'
import { DefaultAWSContextCommands } from './shared/defaultAwsContextCommands'
import { DefaultResourceFetcher } from './shared/defaultResourceFetcher'
import { EnvironmentVariables } from './shared/environmentVariables'
import { ext } from './shared/extensionGlobals'
import { safeGet } from './shared/extensionUtilities'
import * as logger from './shared/logger'
import { DefaultRegionProvider } from './shared/regions/defaultRegionProvider'
import * as SamCliDetection from './shared/sam/cli/samCliDetection'
import { SamCliVersionValidator } from './shared/sam/cli/samCliVersionValidator'
import { DefaultSettingsConfiguration, SettingsConfiguration } from './shared/settingsConfiguration'
import { AWSStatusBar } from './shared/statusBar'
import { AwsTelemetryOptOut } from './shared/telemetry/awsTelemetryOptOut'
import { DefaultTelemetryService } from './shared/telemetry/defaultTelemetryService'
import { registerCommand } from './shared/telemetry/telemetryUtils'
import { ExtensionDisposableFiles } from './shared/utilities/disposableFiles'
import { PromiseSharer } from './shared/utilities/promiseUtilities'

export async function activate(context: vscode.ExtensionContext) {

    const env = process.env as EnvironmentVariables
    if (!!env.VSCODE_NLS_CONFIG) {
        nls.config(JSON.parse(env.VSCODE_NLS_CONFIG) as nls.Options)()
    } else {
        nls.config()()
    }

    const localize = nls.loadMessageBundle()

    ext.context = context
    await logger.initialize()

    const toolkitOutputChannel: vscode.OutputChannel = vscode.window.createOutputChannel(
        localize('AWS.channel.aws.toolkit', 'AWS Toolkit')
    )

    await new DefaultCredentialsFileReaderWriter().setCanUseConfigFileIfExists()

    const awsContext = new DefaultAwsContext(new DefaultSettingsConfiguration(extensionSettingsPrefix))
    const awsContextTrees = new AwsContextTreeCollection()
    const resourceFetcher = new DefaultResourceFetcher()
    const regionProvider = new DefaultRegionProvider(context, resourceFetcher)

    ext.awsContextCommands = new DefaultAWSContextCommands(awsContext, awsContextTrees, regionProvider)
    ext.sdkClientBuilder = new DefaultAWSClientBuilder(awsContext)
    ext.toolkitClientBuilder = new DefaultToolkitClientBuilder()
    ext.statusBar = new AWSStatusBar(awsContext, context)
    ext.telemetry = new DefaultTelemetryService(context)
    new AwsTelemetryOptOut(ext.telemetry, new DefaultSettingsConfiguration(extensionSettingsPrefix))
        .ensureUserNotified()
        .catch((err) => {
            console.warn(`Exception while displaying opt-out message: ${err}`)
        })
    await ext.telemetry.start()

    context.subscriptions.push(...activateCodeLensProviders(awsContext.settingsConfiguration, toolkitOutputChannel))

    registerCommand({
        command: 'aws.login',
        callback: async () => await ext.awsContextCommands.onCommandLogin()
    })

    registerCommand({
        command: 'aws.credential.profile.create',
        callback: async () => await ext.awsContextCommands.onCommandCreateCredentialsProfile()
    })

    registerCommand({
        command: 'aws.logout',
        callback: async () => await ext.awsContextCommands.onCommandLogout()
    })

    registerCommand({
        command: 'aws.showRegion',
        callback: async () => await ext.awsContextCommands.onCommandShowRegion()
    })

    registerCommand({
        command: 'aws.hideRegion',
        callback: async (node?: RegionNode) => {
            await ext.awsContextCommands.onCommandHideRegion(safeGet(node, x => x.regionCode))
        }
    })

    // register URLs in extension menu
    vscode.commands.registerCommand(
        'aws.help',
        () => { vscode.env.openExternal(vscode.Uri.parse(documentationUrl)) }
    )
    vscode.commands.registerCommand(
        'aws.github',
        () => { vscode.env.openExternal(vscode.Uri.parse(githubUrl)) }
    )

    const providers = [
        new LambdaTreeDataProvider(
            awsContext,
            awsContextTrees,
            regionProvider,
            resourceFetcher,
            (relativeExtensionPath) => getExtensionAbsolutePath(context, relativeExtensionPath)
        )
    ]

    providers.forEach((p) => {
        p.initialize(context)
        context.subscriptions.push(vscode.window.registerTreeDataProvider(p.viewProviderId, p))
    })

    await ext.statusBar.updateContext(undefined)

    await initializeSamCli()

    await ExtensionDisposableFiles.initialize(context)

    await resumeCreateNewSamApp(context)
}

export async function deactivate() {
    await ext.telemetry.shutdown()
}

function activateCodeLensProviders(
    configuration: SettingsConfiguration,
    toolkitOutputChannel: vscode.OutputChannel
): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = []

    TypescriptCodeLensProvider.initialize(configuration, toolkitOutputChannel)

    disposables.push(
        vscode.languages.registerCodeLensProvider(
            [
                {
                    language: 'javascript',
                    scheme: 'file',
                },
            ],
            new TypescriptCodeLensProvider()
        )
    )

    return disposables
}

/**
 * Performs SAM CLI relevant extension initialization
 */
async function initializeSamCli(): Promise<void> {
    registerCommand({
        command: 'aws.samcli.detect',
        callback: async () => await PromiseSharer.getExistingPromiseOrCreate(
            'samcli.detect',
            async () => await SamCliDetection.detectSamCli(true)
        )
    })

    registerCommand({
        command: 'aws.samcli.validate.version',
        callback: async () => {
            const samCliVersionValidator = new SamCliVersionValidator()
            await samCliVersionValidator.validateAndNotify()
        }
    })

    await SamCliDetection.detectSamCli(false)
}

function getExtensionAbsolutePath(context: vscode.ExtensionContext, relativeExtensionPath: string): string {
    return context.asAbsolutePath(relativeExtensionPath)
}
