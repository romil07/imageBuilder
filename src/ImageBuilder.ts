import Q = require('q');
import path = require("path");
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import TaskParameters from "./TaskParameters";
import { NullOutstreamStringWritable, getCurrentTime } from "./Utils";
import ImageBuilderClient from "./AzureImageBuilderClient";
import BuildTemplate from "./BuildTemplate";
import { IAuthorizer } from 'azure-actions-webclient/Authorizer/IAuthorizer';
import Util = require('util');
import Utils from "./Utils";
var fs = require('fs');
var archiver = require('archiver');
import * as constants from "./constants";
import { WebRequest } from 'azure-actions-webclient/WebClient';
import { ServiceClient as AzureRestClient } from 'azure-actions-webclient/AzureRestClient';
var azure = require('azure-storage');

var azPath: string;
var storageAccountExists: boolean = false;
export default class ImageBuilder {

    private _taskParameters: TaskParameters;
    private _aibClient: ImageBuilderClient;
    private _buildTemplate: BuildTemplate;
    private _blobService: any;
    private _client: AzureRestClient;

    private subscriptionId: string = "";
    private isVhdDistribute: boolean = false;
    private templateName: string = "";
    private storageAccount: string = "";
    private containerName: string = "";
    private idenityName: string = "";
    private imgBuilderTemplateExists: boolean = false;
    private accountkeys: string = "";

    constructor(resourceAuthorizer: IAuthorizer) {
        try {
            this._taskParameters = new TaskParameters();
            this._buildTemplate = new BuildTemplate(resourceAuthorizer, this._taskParameters);
            this._aibClient = new ImageBuilderClient(resourceAuthorizer, this._taskParameters);
            this._client = new AzureRestClient(resourceAuthorizer);
            this.idenityName = this._taskParameters.managedIdentity;
        }
        catch (error) {
            throw (`error happened while initializing Image builder: ${error}`);
        }
    }

    async execute() {

        try {
            var outStream: any;
            azPath = await io.which("az", true);
            core.debug("Az module path: " + azPath);

            await this.executeAzCliCommand("--version");

            await this.registerFeatures();

            this.sleepFor(2);

            //GENERAL INPUTS
            outStream = await this.executeAzCliCommand("account show");
            this.subscriptionId = JSON.parse(`${outStream}`).id.toString();

            var isCreateBlob = false;
            var imgBuilderId = "";

            console.log("template json provided " + this._taskParameters.isTemplateJsonProvided);
            if (!this._taskParameters.isTemplateJsonProvided) {
                outStream = JSON.parse(await this.executeAzCliCommand(`identity show --resource-group ${this._taskParameters.resourceGroupName} --name ${this.idenityName}`));
                if (outStream != undefined) {
                    imgBuilderId = outStream.id;
                }
            }

            if (this._taskParameters.customizerSource != undefined && this._taskParameters.customizerSource != '' && this._taskParameters.customizerSource != null && this._taskParameters.customizerSource.length >= 1) {
                isCreateBlob = true;
            }
            var blobUrl = "";
            
            if (isCreateBlob) {
                await this.createStorageAccount();

                this.sleepFor(2);

                //create a blob service
                this._blobService = azure.createBlobService(this.storageAccount, this.accountkeys);
                this.containerName = constants.containerName;
                var blobName: string = this._taskParameters.buildFolder + "/" + process.env.GITHUB_RUN_ID + "/" + this._taskParameters.buildFolder + `_${getCurrentTime()}`;
                if (Utils.IsEqual(this._taskParameters.provisioner, "powershell"))
                    blobName = blobName + '.zip';
                else
                    blobName = blobName + '.tar.gz';

                blobUrl = await this.uploadPackage(blobName);
                core.debug("Blob Url: " + blobUrl);
            }

            let templateJson: any = "";
            if (!this._taskParameters.isTemplateJsonProvided) {
                //create template
                core.debug("Creating image template");
                templateJson = await this._buildTemplate.getTemplate(blobUrl, imgBuilderId, this.subscriptionId);
            } else {
                templateJson = this._buildTemplate.addUserCustomisationIfNeeded(blobUrl);
            }

            this.templateName = this.getTemplateName();
            console.log("Template Name = " + this.templateName);
            var runOutputName = this._taskParameters.runOutputName;
            if ((runOutputName == null || runOutputName == undefined || runOutputName.length == 0) && (templateJson.properties.distribute[0].runOutputName != null &&
                templateJson.properties.distribute[0].runOutputName != undefined && templateJson.properties.distribute[0].runOutputName.length >= 1)) {
                runOutputName = templateJson.properties.distribute[0].runOutputName;
            }
            else if (runOutputName == null || runOutputName == undefined || runOutputName.length == 0) {
                runOutputName = this.templateName + "_" + process.env.GITHUB_RUN_ID;
                templateJson.properties.distribute[0].runOutputName = runOutputName;
            }
            this.isVhdDistribute = templateJson.properties.distribute[0].type == "VHD";

            var templateStr = JSON.stringify(templateJson);
            console.log("Image Template JSON: \n" + templateStr);
            this.sleepFor(1);
            await this._aibClient.putImageTemplate(templateStr, this.templateName, this.subscriptionId);
            //we should delete it after run or put template??????????????
            //this.imgBuilderTemplateExists = true;

            await this._aibClient.runTemplate(this.templateName, this.subscriptionId, this._taskParameters.buildTimeoutInMinutes);
            this.imgBuilderTemplateExists = true;
            var out = await this._aibClient.getRunOutput(this.templateName, runOutputName, this.subscriptionId);
            var templateID = await this._aibClient.getTemplateId(this.templateName, this.subscriptionId);
            core.setOutput('templateName', this.templateName);
            core.setOutput('templateId', templateID);
            if (out) {
                core.setOutput('customImageURI', out);
                core.setOutput('imagebuilderRunStatus', "succeeded");
            }

            if (Utils.IsEqual(templateJson.properties.source.type, "PlatformImage")) {
                core.setOutput('pirPublisher', templateJson.properties.source.publisher);
                core.setOutput('pirOffer', templateJson.properties.source.offer);
                core.setOutput('pirSku', templateJson.properties.source.sku);
                core.setOutput('pirVersion', templateJson.properties.source.version);
            }

            console.log("==============================================================================")
            console.log("## task output variables ##");
            console.log("$(imageUri) = ", out);
            if (this.isVhdDistribute) {
                console.log("$(templateName) = ", this.templateName);
                console.log("$(templateId) = ", templateID);
            }
            console.log("==============================================================================")

        }
        catch (error) {
            throw error;
        }
        finally {
            outStream = await this.executeAzCliCommand(`group exists -n ${this._taskParameters.resourceGroupName}`);
            if (outStream) {
                this.cleanup();
            }
        }
    }

    private async createStorageAccount() {
        this.storageAccount = Util.format('%s%s', constants.storageAccountName, getCurrentTime());
        await this.executeAzCliCommand(`storage account create --name "${this.storageAccount}" --resource-group "${this._taskParameters.resourceGroupName}" --location "${this._taskParameters.location}" --sku Standard_RAGRS`);
        core.debug("Created storage account " + this.storageAccount);
        var outStream = await this.executeAzCliCommand(`storage account keys list -g "${this._taskParameters.resourceGroupName}" -n "${this.storageAccount}"`);
        this.accountkeys = JSON.parse(`${outStream}`)[0].value;
        storageAccountExists = true;
    }

    private async registerFeatures() {
        var outStream = await this.executeAzCliCommand(`feature show --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview`);
        if (JSON.parse(outStream) && !Utils.IsEqual(JSON.parse(outStream).properties.state, "Registered")) {
            core.info("Registering Microsoft.VirtualMachineImages");
            await this.executeAzCliCommand("feature register --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview");
            outStream = await this.executeAzCliCommand(`feature show --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview`);
            while (!Utils.IsEqual(JSON.parse(outStream).properties.state, "Registered")) {
                this.sleepFor(1);
                outStream = await this.executeAzCliCommand(`feature show --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview`);
            }
        }

        outStream = '';
        outStream = await this.executeAzCliCommand(`provider show -n Microsoft.VirtualMachineImages`);
        if (JSON.parse(outStream) && !Utils.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
            await this.executeAzCliCommand("provider register -n Microsoft.VirtualMachineImages");
            outStream = await this.executeAzCliCommand(`provider show -n Microsoft.VirtualMachineImages`);
            while (JSON.parse(outStream) && !Utils.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
                this.sleepFor(1);
                outStream = await this.executeAzCliCommand(`provider show -n Microsoft.VirtualMachineImages`);
            }
        }

        outStream = '';
        outStream = await this.executeAzCliCommand(`provider show -n Microsoft.Storage`);
        if (JSON.parse(outStream) && !Utils.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
            core.info("Registering Microsoft.Storage");
            await this.executeAzCliCommand("provider register -n Microsoft.Storage");
            outStream = await this.executeAzCliCommand(`provider show -n Microsoft.Storage`);
            while (JSON.parse(outStream) && !Utils.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
                this.sleepFor(1);
                outStream = await this.executeAzCliCommand(`provider show -n Microsoft.Storage`);
            }
        }

        outStream = '';
        outStream = await this.executeAzCliCommand(`provider show -n Microsoft.Compute`);
        if (JSON.parse(outStream) && !Utils.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
            core.info("Registering Microsoft.Compute");
            await this.executeAzCliCommand("provider register -n Microsoft.Compute");
            outStream = await this.executeAzCliCommand(`provider show -n Microsoft.Compute`);
            while (JSON.parse(outStream) && !Utils.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
                this.sleepFor(1);
                outStream = await this.executeAzCliCommand(`provider show -n Microsoft.Compute`);
            }
        }

        outStream = '';
        outStream = await this.executeAzCliCommand(`provider show -n Microsoft.KeyVault`);
        if (JSON.parse(outStream) && !Utils.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
            core.info("Registering Microsoft.KeyVault");
            await this.executeAzCliCommand("provider register -n Microsoft.KeyVault");
            outStream = await this.executeAzCliCommand(`provider show -n Microsoft.KeyVault`);
            while (JSON.parse(outStream) && !Utils.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
                this.sleepFor(1);
                outStream = await this.executeAzCliCommand(`provider show -n Microsoft.KeyVault`);
            }
        }
    }

    private getTemplateName() {
        if (this._taskParameters.isTemplateJsonProvided) {
            var name = this.getTemplateNameFromProvidedJson();
            return name == "" ? constants.imageTemplateName + getCurrentTime() : name;
        } else if (!this._taskParameters.isTemplateJsonProvided && this._taskParameters.imagebuilderTemplateName) {
            return this._taskParameters.imagebuilderTemplateName;
        }
        return constants.imageTemplateName + getCurrentTime();
    }

    private getTemplateNameFromProvidedJson(): string {
        var template = JSON.parse(this._taskParameters.templateJsonFromUser);
        if (template.tags && template.tags.imagebuilderTemplate) {
            return template.tags.imagebuilderTemplate;
        }

        return "";
    }

    private async uploadPackage(blobName: string): Promise<string> {
        var defer = Q.defer<string>();
        var archivedWebPackage: any;
        var temp = this._generateTemporaryFile(`${process.env.GITHUB_WORKSPACE}`);
        try {
            if (Utils.IsEqual(this._taskParameters.provisioner, "powershell")) {
                temp = temp + `.zip`;
                archivedWebPackage = await this.createArchiveTar(this._taskParameters.buildPath, temp, "zip");
            }
            else {
                temp = temp + `.tar.gz`;
                archivedWebPackage = await this.createArchiveTar(this._taskParameters.buildPath, temp, "tar");
            }
        }
        catch (error) {
            defer.reject(console.log(`unable to create archive build: ${error}`));
        }
        console.log(`created  archive ` + archivedWebPackage);

        this._blobService.createContainerIfNotExists(this.containerName, (error: any) => {
            if (error) {
                defer.reject(console.log(`unable to create container ${this.containerName} in storage account: ${error}`));
            }

            //upoading package
            this._blobService.createBlockBlobFromLocalFile(this.containerName, blobName, archivedWebPackage, (error: any, result: any) => {
                if (error) {
                    defer.reject(console.log(`unable to create blob ${blobName} in container ${this.containerName} in storage account: ${error}`));
                }
                //generating SAS URL
                var startDate = new Date();
                var expiryDate = new Date(startDate);
                expiryDate.setFullYear(startDate.getUTCFullYear() + 1);
                startDate.setMinutes(startDate.getMinutes() - 5);

                var sharedAccessPolicy = {
                    AccessPolicy: {
                        Permissions: azure.BlobUtilities.SharedAccessPermissions.READ,
                        Start: startDate,
                        Expiry: expiryDate
                    }
                };

                var token = this._blobService.generateSharedAccessSignature(this.containerName, blobName, sharedAccessPolicy);
                var blobUrl = this._blobService.getUrl(this.containerName, blobName, token);
                defer.resolve(blobUrl);
            });
        });
        return defer.promise;
    }

    public async createArchiveTar(sourcePath: string, targetPath: string, extension: string) {
        var defer = Q.defer();
        console.log('Archiving ' + sourcePath + ' to ' + targetPath);
        var output = fs.createWriteStream(targetPath);
        var archive: any;

        if (Utils.IsEqual(extension, 'zip')) {
            archive = archiver('zip', { zlib: { level: 9 } });
        }
        else {
            archive = archiver('tar', {
                gzip: true,
                gzipOptions: {
                    level: 1
                }
            });
        }

        output.on('close', function () {
            console.log(archive.pointer() + ' total bytes');
            core.debug('Successfully created archive ' + targetPath);
            defer.resolve(targetPath);
        });

        output.on('error', function (error: any) {
            defer.reject(error);
        });

        var stats = fs.statSync(sourcePath);
        if (stats.isFile()) {
            archive.file(sourcePath, { name: this._taskParameters.buildFolder });
        }
        else {
            archive.glob("**", {
                cwd: sourcePath,
                dot: true
            });
        }
        archive.pipe(output);
        archive.finalize();

        return defer.promise;
    }

    private _generateTemporaryFile(folderPath: string): string {
        var randomString = Math.random().toString().split('.')[1];
        var tempPath = path.join(folderPath, '/temp_web_package_' + randomString);
        return tempPath;
    }

    private async cleanup() {
        try {
            if (!this.isVhdDistribute && this.imgBuilderTemplateExists) {
                await this._aibClient.deleteTemplate(this.templateName, this.subscriptionId);
                console.log(`${this.templateName} got deleted`);
            }
            if (storageAccountExists) {
                let httpRequest: WebRequest = {
                    method: 'DELETE',
                    uri: this._client.getRequestUri(`subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts/{storageAccount}`, { '{subscriptionId}': this.subscriptionId, '{resourceGroupName}': this._taskParameters.resourceGroupName, '{storageAccount}': this.storageAccount }, [], "2019-06-01")
                };
                var response = await this._client.beginRequest(httpRequest);
                console.log("storage account " + this.storageAccount + " deleted");
            }
        }
        catch (error) {
            console.log(`Error in cleanup: `, error);
        }
    }

    async executeAzCliCommand(command: string): Promise<string> {
        var outStream: string = '';
        console.log("command " + command);
        var execOptions: any = {
            outStream: new NullOutstreamStringWritable({ decodeStrings: false }),
            listeners: {
                stdout: (data: any) => outStream += data.toString(),
            }
        };
        try {
            await exec.exec(`"${azPath}" ${command}`, [], execOptions);
            return outStream;
        }
        catch (error) {
            throw error;
        }
    }

    private sleepFor(sleepDurationInSeconds: any): Promise<any> {
        return new Promise((resolve, reeject) => {
            setTimeout(resolve, sleepDurationInSeconds * 1000);
        });
    }
}