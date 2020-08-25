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
var roleDefinitionExists: boolean = false;
var managedIdentityExists: boolean = false;
var roleAssignmentForManagedIdentityExists: boolean = false;
var storageAccountExists: boolean = false;
var roleAssignmentForStorageAccountExists: boolean = false;
export default class ImageBuilder {

    private _taskParameters: TaskParameters;
    private _aibClient: ImageBuilderClient;
    private _buildTemplate: BuildTemplate;
    private _blobService: any;
    private _client: AzureRestClient;

    private isVhdDistribute: boolean = false;
    private templateName: string = "";
    private storageAccount: string = "";
    private containerName: string = "";
    private principalId = "";
    private idenityName: string = "";
    private imageRoleDefName: string = "";
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

            azPath = await io.which("az", true);
            core.debug("Az module path: " + azPath);
            // var outStream = '';
            await this.executeAzCliCommand("--version");

            //this.registerFeatures();

            //GENERAL INPUTS
            outStream = await this.executeAzCliCommand("account show");
            var subscriptionId = JSON.parse(`${outStream}`).id.toString();

            var isCreateBlob = false;
            var imgBuilderId = "";
            
            if (!this._taskParameters.isTemplateJsonProvided) {
                isCreateBlob = true;
                // handle resource group
                if (this._taskParameters.resourceGroupName == null || this._taskParameters.resourceGroupName == undefined || this._taskParameters.resourceGroupName.length == 0) {
                    var resourceGroupName = Util.format('%s%s', constants.resourceGroupName, getCurrentTime());
                    this._taskParameters.resourceGroupName = resourceGroupName;
                    await this.executeAzCliCommand(`group create -n ${resourceGroupName} -l ${this._taskParameters.location}`);
                }

                console.log("identity-name = " + this.idenityName);
                imgBuilderId = `/subscriptions/${subscriptionId}/resourcegroups/${this._taskParameters.resourceGroupName}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${this.idenityName}`;
                this.principalId = JSON.parse(await this.executeAzCliCommand(`identity show --resource-group ${this._taskParameters.resourceGroupName} --name ${this.idenityName}`)).principalId;

                await this.createStorageAccount();

            } else {
                var template = JSON.parse(this._taskParameters.templateJsonFromUser);
                if (this._taskParameters.customizerSource) {
                    isCreateBlob = true;
                    var identities = template.identity.userAssignedIdentities

                    var keys = Object.keys(identities);
                    if (keys && keys.length >= 1) {
                        this.idenityName = keys[0];
                    }
                    var name = this.idenityName.split(path.sep);
                    this.idenityName = name[name.length - 1];
                    console.log("identity-name = " + this.idenityName);

                    this.principalId = JSON.parse(await this.executeAzCliCommand(`identity show --resource-group ${this._taskParameters.resourceGroupName} --name ${this.idenityName}`)).principalId;
                    console.log("Principal id = " + this.principalId);
                    await this.createStorageAccount();
                }
            }

            var blobUrl = "";
            if (isCreateBlob) {
                //create a blob service
                this._blobService = azure.createBlobService(this.storageAccount, this.accountkeys);
                this.containerName = constants.containerName;
                var blobName : string = this._taskParameters.buildFolder + "/" + process.env.GITHUB_RUN_ID + "/" + this._taskParameters.buildFolder + `_${getCurrentTime()}`;
                if (Utils.IsEqual(this._taskParameters.provisioner, "powershell"))
                    blobName = blobName + '.zip';
                else
                    blobName = blobName + '.tar.gz';

                blobUrl = await this.uploadPackage(this.containerName, blobName);
                core.debug("Blob Url: " + blobUrl);
            }

            let templateJson: any = "";
            if (!this._taskParameters.isTemplateJsonProvided) {
                templateJson = await this._buildTemplate.getTemplate(blobUrl, imgBuilderId, subscriptionId);
                console.log("Template Json = \n" + templateJson);
            } else {
                templateJson = this._buildTemplate.addUserCustomisationIfNeeded(blobUrl);
            }

            this.templateName = this.getTemplateName();
            var runOutputName = this._taskParameters.runOutputName;
            if (runOutputName == null || runOutputName == undefined || runOutputName.length == 0) {
                runOutputName = this.templateName + "_" + process.env.GITHUB_RUN_ID;
                templateJson.properties.distribute[0].runOutputName = runOutputName;
            }
            this.isVhdDistribute = templateJson.properties.distribute[0].type == "VHD";

            var templateStr = JSON.stringify(templateJson);
            console.log("Template json: \n" + templateStr);
            await this._aibClient.putImageTemplate(templateStr, this.templateName, subscriptionId);
            this.imgBuilderTemplateExists = true;

            await this._aibClient.runTemplate(this.templateName, subscriptionId, this._taskParameters.buildTimeoutInMinutes);
            var out = await this._aibClient.getRunOutput(this.templateName, runOutputName, subscriptionId);
            var templateID = await this._aibClient.getTemplateId(this.templateName, subscriptionId);
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
            var outStream = await this.executeAzCliCommand(`group exists -n ${this._taskParameters.resourceGroupName}`);
            if (outStream) {
                //this.cleanup(this.isVhdDistribute, this.templateName, this.imgBuilderTemplateExists, subscriptionId, this.storageAccount, this.containerName, this.accountkeys, this.idenityName, this.principalId, this.imageRoleDefName);
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
            var name = this.getTemplateNameFromProvidedJson(this._taskParameters.templateJsonFromUser);
            return name == "" ? constants.imageTemplateName + getCurrentTime() : name;
        } else if (!this._taskParameters.isTemplateJsonProvided && this._taskParameters.imagebuilderTemplateName) {
            return this._taskParameters.imagebuilderTemplateName;
        }
        return constants.imageTemplateName + getCurrentTime();
    }

    private getTemplateNameFromProvidedJson(templateJson: string): string {
        var template = JSON.parse(templateJson);
        if (template.tags && template.tags.imagebuilderTemplate) {
            return template.tags.imagebuilderTemplate;
        }

        return "";
    }

    private async uploadPackage(containerName: string, blobName: string): Promise<string> {

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
        console.log(`created archive ` + archivedWebPackage);

        this._blobService.createContainerIfNotExists(containerName, (error: any) => {
            if (error) {
                defer.reject(console.log(`unable to create container ${containerName} in storage account: ${error}`));
            }

            //upoading package
            this._blobService.createBlockBlobFromLocalFile(containerName, blobName, archivedWebPackage, (error: any, result: any) => {
                if (error) {
                    defer.reject(console.log(`unable to create blob ${blobName} in container ${containerName} in storage account: ${error}`));
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

                var token = this._blobService.generateSharedAccessSignature(containerName, blobName, sharedAccessPolicy);
                var blobUrl = this._blobService.getUrl(containerName, blobName, token);
                defer.resolve(blobUrl);
            });
        });
        return defer.promise;
    }

    public async createArchiveTar(folderPath: string, targetPath: string, extension: string) {
        var defer = Q.defer();
        console.log('Archiving ' + folderPath + ' to ' + targetPath);
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

        archive.glob("**", {
            cwd: folderPath,
            dot: true
        });
        archive.pipe(output);
        archive.finalize();

        return defer.promise;
    }

    private _generateTemporaryFile(folderPath: string): string {
        var randomString = Math.random().toString().split('.')[1];
        var tempPath = path.join(folderPath, '/temp_web_package_' + randomString);
        return tempPath;
    }

    private async cleanup(isVhdDistribute: boolean, templateName: string, imgBuilderTemplateExists: boolean, subscriptionId: string, storageAccount: string, containerName: string, accountkeys: string, idenityName: string, principalId: string, imageRoleDefName: string) {
        try {
            if (!isVhdDistribute && imgBuilderTemplateExists) {
                await this._aibClient.deleteTemplate(templateName, subscriptionId);
                console.log(`${templateName} got deleted`);
            }
            if (roleAssignmentForStorageAccountExists) {
                await this.executeAzCliCommand(`role assignment delete --assignee ${principalId} --role "Storage Blob Data Reader" --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${storageAccount}/blobServices/default/containers/${containerName}`);
                console.log("role assignment for storage account deleted");
            }
            if (storageAccountExists) {
                let httpRequest: WebRequest = {
                    method: 'DELETE',
                    uri: this._client.getRequestUri(`subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts/{storageAccount}`, { '{subscriptionId}': subscriptionId, '{resourceGroupName}': this._taskParameters.resourceGroupName, '{storageAccount}': storageAccount }, [], "2019-06-01")
                };
                var response = await this._client.beginRequest(httpRequest);
                console.log("storage account " + storageAccount + " deleted");
            }
            if (roleAssignmentForManagedIdentityExists) {
                await this.executeAzCliCommand(`role assignment delete --assignee ${principalId} --role ${imageRoleDefName} --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}`);
                console.log("role assignment deleted");
            }
            if (managedIdentityExists) {
                await this.executeAzCliCommand(`identity delete -n ${idenityName} -g ${this._taskParameters.resourceGroupName}`);
                console.log(`identity ${idenityName} deleted`);
            }
            if (roleDefinitionExists) {
                await this.executeAzCliCommand(`role definition delete --name ${imageRoleDefName}`);
                console.log(`role definition ${imageRoleDefName} deleted`);
            }
        }
        catch (error) {
            console.log(`Error in cleanup: `, error);
        }
    }

    async executeAzCliCommand(command: string): Promise<string> {
        var outStream: string = '';
        console.log("az cli command " + command);
        var execOptions: any = {
            listeners: {
                stdout: (data: any) => outStream += data.toString(),
            }
        };
        try {
            await exec.exec(`"${azPath}" ${command}`, [], execOptions);
            return outStream;
        }
        catch (error) {
            core.error("cli command failed with following output: \n" + error);
            core.setFailed("Action run failed");
            throw error;
        }
    }

    private sleepFor(sleepDurationInSeconds: any): Promise<any> {
        return new Promise((resolve, reeject) => {
            setTimeout(resolve, sleepDurationInSeconds * 1000);
        });
    }
}