import Q = require('q');
import path = require("path");
import * as tl from '@actions/core';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import TaskParameters from "./TaskParameters";
import { NullOutstreamStringWritable, getCurrentTime } from "./Utils";
import ImageBuilderClient from "./AzureImageBuilderClient";
import BuildTemplate from "./BuildTemplate";
import { IAuthorizer } from 'azure-actions-webclient/Authorizer/IAuthorizer';
const { BlobServiceClient, StorageSharedKeyCredential, BlobURL, BlockBlobURL, StorageURL, ServiceURL, ContainerURL, Aborter } = require("@azure/storage-blob");
import Util = require('util');
import Utils from "./Utils";
var fs = require('fs');
var targz = require('tar.gz');
const zl = require("zip-lib");
var archiver = require('archiver');
import * as constants from "./constants";
import { WebRequest, WebResponse } from 'azure-actions-webclient/WebClient';
import { ServiceClient as AzureRestClient, ToError, AzureError } from 'azure-actions-webclient/AzureRestClient';

var azPath: string;
//var outputStream: string;
export default class ImageBuilder {

    private _taskParameters: TaskParameters;
    private _aibClient: ImageBuilderClient;
    private _buildTemplate: BuildTemplate;
    private _blobService: any;
    private resourceAuthorizer: IAuthorizer;
    private _client: AzureRestClient;

    constructor(resourceAuthorizer: IAuthorizer) {
        try {
            this.resourceAuthorizer = resourceAuthorizer;
            this._taskParameters = new TaskParameters();
            this._buildTemplate = new BuildTemplate(resourceAuthorizer, this._taskParameters);
            this._aibClient = new ImageBuilderClient(resourceAuthorizer, this._taskParameters);
            this._client = new AzureRestClient(resourceAuthorizer);
        }
        catch (error) {
            throw (`error happened while initializing Image builder: ${error}`);
            core.error(error);
        }
    }

    async execute() {
        try {
            azPath = await io.which("az", true);
            console.log("azpath " + azPath);
            await this.executeAzCliCommand("--version");
            //Register all features for Azure Image Builder Service
            await this.executeAzCliCommand("feature register --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview");
            await this.executeAzCliCommand("provider register -n Microsoft.VirtualMachineImages");
            await this.executeAzCliCommand("provider register -n Microsoft.Storage");
            await this.executeAzCliCommand("provider register -n Microsoft.Compute");
            await this.executeAzCliCommand("provider register -n Microsoft.KeyVault");

            var outStream: string = '';
            var execOptions: any = {
                outStream: new NullOutstreamStringWritable({ decodeStrings: false }),
                listeners: {
                    stdout: (data: any) => outStream += data.toString(),
                }
            };
            await this.executeAzCliCommand("account show ", execOptions);
            var subscriptionId = JSON.parse(`${outStream}`).id.toString();

            if (this._taskParameters.resourceGroupName == null || this._taskParameters.resourceGroupName == undefined || this._taskParameters.resourceGroupName.length == 0) {
                var resourceGroupName = Util.format('%s%s', constants.resourceGroupName, getCurrentTime());
                this._taskParameters.resourceGroupName = resourceGroupName;
                await this.executeAzCliCommand(`group create -n "${resourceGroupName}" -l "${this._taskParameters.location}"`, execOptions);
                console.log("resource group " + resourceGroupName + " got created");
            }

            var imgBuilderId = "";
            var idenityName = "";
            outStream = '';
            execOptions = {
                outStream: new NullOutstreamStringWritable({ decodeStrings: false }),
                listeners: {
                    stdout: (data: any) => outStream += data.toString()
                }
            };

            idenityName = Util.format('%s%s', constants.identityName, getCurrentTime());
            await this.executeAzCliCommand(`identity create -n "${idenityName}" -g "${this._taskParameters.resourceGroupName}"`, execOptions);
            console.log("identity " + idenityName + " got created inside resource group name " + this._taskParameters.resourceGroupName);

            imgBuilderId = `/subscriptions/${subscriptionId}/resourcegroups/${this._taskParameters.resourceGroupName}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${idenityName}`;

            var principalId = JSON.parse(`${outStream}`).principalId.toString();
            var imgBuilderCliId = JSON.parse(`${outStream}`).clientId.toString();
            console.log("imgBuilderCliId " + imgBuilderCliId);

            outStream = '';
            
            var imageRoleDefName="aibImageDef" + getCurrentTime();
            var template = `{
                "Name": "${imageRoleDefName}",
                "IsCustom": true,
                "Description": "Image Builder access to create resources for the image build, you should delete or split out as appropriate",
                "Actions": [
                    "Microsoft.Compute/galleries/read",
                    "Microsoft.Compute/galleries/images/read",
                    "Microsoft.Compute/galleries/images/versions/read",
                    "Microsoft.Compute/galleries/images/versions/write",
            
                    "Microsoft.Compute/images/write",
                    "Microsoft.Compute/images/read",
                    "Microsoft.Compute/images/delete"
                ],
                "NotActions": [
                
                ],
                "AssignableScopes": [
                    "/subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}"
                ]
            }`;
            
            var templateJson = JSON.parse(template);
            console.log(" stringify "+JSON.stringify(templateJson));
            fs.writeFileSync('./src/template.json', JSON.stringify(templateJson));

            await this.executeAzCliCommand(`role definition create --role-definition ./src/template.json`);
            await this.executeAzCliCommand(`role assignment create --assignee-object-id ${principalId} --role ${imageRoleDefName} --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}`)
            
            //CUSTOMIZER INPUTS
            //create storage account
            var storageAccount = Util.format('%s%s', constants.storageAccountName, getCurrentTime());
            //get stoarge account keys
            outStream = '';
            await this.executeAzCliCommand(`storage account create --name "${storageAccount}" --resource-group "${this._taskParameters.resourceGroupName}" --location "${this._taskParameters.location}" --sku Standard_RAGRS`);
            await this.executeAzCliCommand(`storage account keys list -g "${this._taskParameters.resourceGroupName}" -n "${storageAccount}"`, execOptions);
            var accountkeys = JSON.parse(`${outStream}`)[0].value;

            //create blob service
            const sharedKeyCredential = new StorageSharedKeyCredential(storageAccount, accountkeys);
            this._blobService = new BlobServiceClient(
                `https://${storageAccount}.blob.core.windows.net`,
                sharedKeyCredential
            );

            const containerName: string = 'imagebuilder-vststask';
           // var blobName: string = this._taskParameters.buildFolder + "/" + this._taskParameters.buildFolder + `_${getCurrentTime()}`;
           var blobName: string = this._taskParameters.buildFolder + `_${getCurrentTime()}`;
            if (Utils.IsEqual(this._taskParameters.provisioner, "powershell"))
                blobName = blobName + '.zip';
            else
                blobName = blobName + '.tar.gz';
            console.log("blob name " + blobName);
            var blobUrl = await this.uploadPackage(containerName, blobName);
            
            //assign identity to storage account
            await this.executeAzCliCommand(`role assignment create --assignee-object-id ${principalId} --role "Storage Blob Data Reader" --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${storageAccount}/blobServices/default/containers/${containerName}`)
            
            //create template
            console.log("template creation");
            var templateJson = await this._buildTemplate.getTemplate(blobUrl, imgBuilderId, subscriptionId);
            var templateName = this.getTemplateName();
            console.log("template name: ", templateName);
            var runOutputName = this._taskParameters.runOutputName;
            if (runOutputName == null || runOutputName == undefined || runOutputName.length == 0) {
                runOutputName = templateJson.properties.distribute[0].runOutputName;
            }
            var isVhdDistribute = templateJson.properties.distribute[0].type == "VHD";

            var templateStr = JSON.stringify(templateJson);
            console.log("templatestr "+ templateStr);
            await this._aibClient.putImageTemplate(templateStr, templateName, subscriptionId);
            await this._aibClient.runTemplate(templateName, subscriptionId);
            var out = await this._aibClient.getRunOutput(templateName, runOutputName, subscriptionId);
            var templateID = await this._aibClient.getTemplateId(templateName, subscriptionId);
            tl.setOutput(runOutputName, templateName);
            tl.setOutput('templateId', templateID);
            if (out) {
                tl.setOutput('customImageURI', out);
                tl.setOutput('imagebuilderRunStatus', "succeeded");
            }

            if (Utils.IsEqual(templateJson.properties.source.type, "PlatformImage")) {
                tl.setOutput('pirPublisher', templateJson.properties.source.publisher);
                tl.setOutput('pirOffer', templateJson.properties.source.offer);
                tl.setOutput('pirSku', templateJson.properties.source.sku);
                tl.setOutput('pirVersion', templateJson.properties.source.version);
            }

            console.log("==============================================================================")
            console.log("## task output variables ##");
            console.log("$(imageUri) = ", out);
            if (isVhdDistribute) {
                console.log("$(templateName) = ", templateName);
                console.log("$(templateId) = ", templateID);
            }
            console.log("==============================================================================")

            this.cleanup(isVhdDistribute, templateName, subscriptionId, storageAccount, containerName, idenityName, principalId, imageRoleDefName);

        }
        catch (error) {
            console.log("E R R O R" + core.setFailed(error));
            tl.setOutput('imagebuilderRunStatus', "failed");
            throw error;
        }
    }

    private getTemplateName() {
        if (this._taskParameters.imagebuilderTemplateName) {
            return this._taskParameters.imagebuilderTemplateName
        }
        return "imagebuilderTemplate" + getCurrentTime();
    }

    private async uploadPackage(containerName: string, blobName: string): Promise<string> {
        
        var defer = Q.defer<string>();
        var archivedWebPackage: any;
        var temp: any;
        console.log("this._taskParameters.buildPath " + this._taskParameters.buildPath);
        try {
            if (Utils.IsEqual(this._taskParameters.provisioner, "powershell")) {
                archivedWebPackage = await this.createArchiveTar1(this._taskParameters.buildPath,
                    this._generateTemporaryFile('/home/runner/work/AIB_Action_1/AIB_Action_1/', `.zip`));
            }
            else {
                archivedWebPackage = await this.createArchiveTar(this._taskParameters.buildPath,
                    this._generateTemporaryFile('/home/runner/work/AIB_Action_1/AIB_Action_1/', `.tar.gz`));
            }
        }
        catch (error) {
            defer.reject(console.log(`unable to create archive build: ${error}`));
        }
        console.log(`created  archive`);

        //create container,blob and return bloburl
        console.log("containerName " + containerName);
        const containerClient = this._blobService.getContainerClient(containerName);
        //createIfNotExists
        const createContainerResponse = await containerClient.create();
        console.log(`Create container ${containerName} successfully`, createContainerResponse.requestId);
        //const content = "Hello world!";
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        var uploadBlobResponse: any;
        var content = "hello world";
        // uploadBlobResponse = await blockBlobClient.upload(archivedWebPackage, archivedWebPackage.length);
        uploadBlobResponse = await blockBlobClient.upload(archivedWebPackage, archivedWebPackage.length);
        console.log(`Upload block blob ${blobName} successfully`, uploadBlobResponse.requestId);
        console.log("blockBlobClient.url " + blockBlobClient.url)
        //return blockBlobClient.url;
        defer.resolve(blockBlobClient.url);
        return defer.promise;
    }

    public async createArchiveTar(folderPath: string, targetPath: string) {
        var defer = Q.defer();
        console.log('Archiving ' + folderPath + ' to ' + targetPath);
        var output = fs.createWriteStream(targetPath);
        var archive = archiver('tar', {
            gzip: true,
            gzipOptions: {
                level: 1
            }
        });

        output.on('close', function () {
            console.log(archive.pointer() + ' total bytes');
            tl.debug('Successfully created archive ' + targetPath);
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

    public async createArchiveTar1(folderPath: string, targetPath: string) {
        var defer = Q.defer();
        var output = fs.createWriteStream(targetPath);
        var archive = archiver('zip', { zlib: { level: 9 }});

        output.on('close', function () {
            console.log(archive.pointer() + ' total bytes');
            console.log('archiver has been finalized and the output file descriptor has closed.');
            defer.resolve(targetPath);
        });

        archive.on('error', function (err: any) {
            defer.reject(err);
        });

        archive.glob(folderPath);
        archive.pipe(output);

        // append files from a sub-directory and naming it `new-subdir` within the archive (see docs for more options):
        //archive.directory(source_dir, false);
        
        archive.finalize();
        return defer.promise;
    }

    private _generateTemporaryFile(folderPath: string, extension: string): string {
        var randomString = Math.random().toString().split('.')[1];
        var tempPath = path.join(folderPath, 'temp_web_package_' + randomString + extension);
        return tempPath;
    }


    async executeAzCliCommand(command: string, options?: any): Promise<number> {
        try {
            return await exec.exec(`"${azPath}" ${command}`, [], options);
        }
        catch (error) {
            throw new Error(error);
        }
    }

    private async cleanup(isVhdDistribute: boolean, templateName: string, subscriptionId: string, storageAccount: string, containerName: string, idenityName: string, principalId: string, imageRoleDefName: string) {
        try {
            if (!isVhdDistribute) {
                // Promise.all([this._aibClient.deleteTemplate(templateName, subscriptionId), this.deleteBlob(containerName, blobName)]);
                await this._aibClient.deleteTemplate(templateName, subscriptionId);
                
            }
            await this.executeAzCliCommand(`role assignment create --assignee-object-id ${principalId} --role "Storage Blob Data Reader" --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${storageAccount}/blobServices/default/containers/${containerName}`);
            console.log("role assignment for storage account deleted");
            let httpRequest: WebRequest = {
                method: 'DELETE',
                uri: this._client.getRequestUri(`subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts/{storageAccount}`, { '{subscriptionId}': subscriptionId, '{resourceGroupName}': this._taskParameters.resourceGroupName, '{storageAccount}': storageAccount }, [], "2019-06-01")
            };
            var response = await this._client.beginRequest(httpRequest);
            console.log("response from delete " + response.statusMessage + " code " + response.statusCode + "   status " + response.body.status);
            console.log("storage account " + storageAccount + " deleted");
            await this.executeAzCliCommand(`role assignment delete --assignee ${principalId} --role ${imageRoleDefName} --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}`);
            console.log("role assignment deleted");
            await this.executeAzCliCommand(`identity delete -n ${idenityName} -g ${this._taskParameters.resourceGroupName}`);
            console.log("identity " + idenityName + " deleted");
        }
        catch (error) {
            console.log(`Error in cleanup: `, error);
        }
    }

    getExecuteOptions(): any {
        var outStream = '';
        var execOptions: any = {
            outStream: new NullOutstreamStringWritable({ decodeStrings: false }),
            listeners: {
                stdout: (data: any) => outStream += data.toString()
            }
        };
        return execOptions;
    }

}