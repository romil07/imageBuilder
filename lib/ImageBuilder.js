"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Q = require("q");
const path = require("path");
const tl = __importStar(require("@actions/core"));
const core = __importStar(require("@actions/core"));
const exec = __importStar(require("@actions/exec"));
const io = __importStar(require("@actions/io"));
const TaskParameters_1 = __importDefault(require("./TaskParameters"));
const Utils_1 = require("./Utils");
const AzureImageBuilderClient_1 = __importDefault(require("./AzureImageBuilderClient"));
const BuildTemplate_1 = __importDefault(require("./BuildTemplate"));
const { BlobServiceClient, StorageSharedKeyCredential, BlobURL, BlockBlobURL, StorageURL, ServiceURL, ContainerURL, Aborter } = require("@azure/storage-blob");
const Util = require("util");
const Utils_2 = __importDefault(require("./Utils"));
var fs = require('fs');
var targz = require('tar.gz');
const zl = require("zip-lib");
var archiver = require('archiver');
const constants = __importStar(require("./constants"));
const AzureRestClient_1 = require("azure-actions-webclient/AzureRestClient");
var azPath;
//var outputStream: string;
class ImageBuilder {
    constructor(resourceAuthorizer) {
        try {
            this.resourceAuthorizer = resourceAuthorizer;
            this._taskParameters = new TaskParameters_1.default();
            this._buildTemplate = new BuildTemplate_1.default(resourceAuthorizer, this._taskParameters);
            this._aibClient = new AzureImageBuilderClient_1.default(resourceAuthorizer, this._taskParameters);
            this._client = new AzureRestClient_1.ServiceClient(resourceAuthorizer);
        }
        catch (error) {
            throw (`error happened while initializing Image builder: ${error}`);
            core.error(error);
        }
    }
    execute() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                azPath = yield io.which("az", true);
                console.log("azpath " + azPath);
                yield this.executeAzCliCommand("--version");
                //Register all features for Azure Image Builder Service
                yield this.executeAzCliCommand("feature register --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview");
                yield this.executeAzCliCommand("provider register -n Microsoft.VirtualMachineImages");
                yield this.executeAzCliCommand("provider register -n Microsoft.Storage");
                yield this.executeAzCliCommand("provider register -n Microsoft.Compute");
                yield this.executeAzCliCommand("provider register -n Microsoft.KeyVault");
                var outStream = '';
                var execOptions = {
                    outStream: new Utils_1.NullOutstreamStringWritable({ decodeStrings: false }),
                    listeners: {
                        stdout: (data) => outStream += data.toString(),
                    }
                };
                yield this.executeAzCliCommand("account show ", execOptions);
                var subscriptionId = JSON.parse(`${outStream}`).id.toString();
                if (this._taskParameters.resourceGroupName == null || this._taskParameters.resourceGroupName == undefined || this._taskParameters.resourceGroupName.length == 0) {
                    var resourceGroupName = Util.format('%s%s', constants.resourceGroupName, Utils_1.getCurrentTime());
                    this._taskParameters.resourceGroupName = resourceGroupName;
                    yield this.executeAzCliCommand(`group create -n "${resourceGroupName}" -l "${this._taskParameters.location}"`, execOptions);
                    console.log("resource group " + resourceGroupName + " got created");
                }
                var imgBuilderId = "";
                var idenityName = "";
                outStream = '';
                execOptions = {
                    outStream: new Utils_1.NullOutstreamStringWritable({ decodeStrings: false }),
                    listeners: {
                        stdout: (data) => outStream += data.toString()
                    }
                };
                idenityName = Util.format('%s%s', constants.identityName, Utils_1.getCurrentTime());
                yield this.executeAzCliCommand(`identity create -n "${idenityName}" -g "${this._taskParameters.resourceGroupName}"`, execOptions);
                console.log("identity " + idenityName + " got created inside resource group name " + this._taskParameters.resourceGroupName);
                imgBuilderId = `/subscriptions/${subscriptionId}/resourcegroups/${this._taskParameters.resourceGroupName}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${idenityName}`;
                var principalId = JSON.parse(`${outStream}`).principalId.toString();
                var imgBuilderCliId = JSON.parse(`${outStream}`).clientId.toString();
                console.log("imgBuilderCliId " + imgBuilderCliId);
                outStream = '';
                var imageRoleDefName = "aibImageDef" + Utils_1.getCurrentTime();
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
                console.log(" stringify " + JSON.stringify(templateJson));
                fs.writeFileSync('./src/template.json', JSON.stringify(templateJson));
                yield this.executeAzCliCommand(`role definition create --role-definition ./src/template.json`);
                yield this.executeAzCliCommand(`role assignment create --assignee-object-id ${principalId} --role ${imageRoleDefName} --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}`);
                //CUSTOMIZER INPUTS
                //create storage account
                var storageAccount = Util.format('%s%s', constants.storageAccountName, Utils_1.getCurrentTime());
                //get stoarge account keys
                outStream = '';
                yield this.executeAzCliCommand(`storage account create --name "${storageAccount}" --resource-group "${this._taskParameters.resourceGroupName}" --location "${this._taskParameters.location}" --sku Standard_RAGRS`);
                yield this.executeAzCliCommand(`storage account keys list -g "${this._taskParameters.resourceGroupName}" -n "${storageAccount}"`, execOptions);
                var accountkeys = JSON.parse(`${outStream}`)[0].value;
                //create blob service
                const sharedKeyCredential = new StorageSharedKeyCredential(storageAccount, accountkeys);
                this._blobService = new BlobServiceClient(`https://${storageAccount}.blob.core.windows.net`, sharedKeyCredential);
                const containerName = 'imagebuilder-vststask';
                // var blobName: string = this._taskParameters.buildFolder + "/" + this._taskParameters.buildFolder + `_${getCurrentTime()}`;
                var blobName = this._taskParameters.buildFolder + `_${Utils_1.getCurrentTime()}`;
                if (Utils_2.default.IsEqual(this._taskParameters.provisioner, "powershell"))
                    blobName = blobName + '.zip';
                else
                    blobName = blobName + '.tar.gz';
                console.log("blob name " + blobName);
                var blobUrl = yield this.uploadPackage(containerName, blobName);
                //assign identity to storage account
                yield this.executeAzCliCommand(`role assignment create --assignee-object-id ${principalId} --role "Storage Blob Data Reader" --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${storageAccount}/blobServices/default/containers/${containerName}`);
                //create template
                console.log("template creation");
                var templateJson = yield this._buildTemplate.getTemplate(blobUrl, imgBuilderId, subscriptionId);
                var templateName = this.getTemplateName();
                console.log("template name: ", templateName);
                var runOutputName = this._taskParameters.runOutputName;
                if (runOutputName == null || runOutputName == undefined || runOutputName.length == 0) {
                    runOutputName = templateJson.properties.distribute[0].runOutputName;
                }
                var isVhdDistribute = templateJson.properties.distribute[0].type == "VHD";
                var templateStr = JSON.stringify(templateJson);
                console.log("templatestr " + templateStr);
                yield this._aibClient.putImageTemplate(templateStr, templateName, subscriptionId);
                yield this._aibClient.runTemplate(templateName, subscriptionId);
                var out = yield this._aibClient.getRunOutput(templateName, runOutputName, subscriptionId);
                var templateID = yield this._aibClient.getTemplateId(templateName, subscriptionId);
                tl.setOutput(runOutputName, templateName);
                tl.setOutput('templateId', templateID);
                if (out) {
                    tl.setOutput('customImageURI', out);
                    tl.setOutput('imagebuilderRunStatus', "succeeded");
                }
                if (Utils_2.default.IsEqual(templateJson.properties.source.type, "PlatformImage")) {
                    tl.setOutput('pirPublisher', templateJson.properties.source.publisher);
                    tl.setOutput('pirOffer', templateJson.properties.source.offer);
                    tl.setOutput('pirSku', templateJson.properties.source.sku);
                    tl.setOutput('pirVersion', templateJson.properties.source.version);
                }
                console.log("==============================================================================");
                console.log("## task output variables ##");
                console.log("$(imageUri) = ", out);
                if (isVhdDistribute) {
                    console.log("$(templateName) = ", templateName);
                    console.log("$(templateId) = ", templateID);
                }
                console.log("==============================================================================");
                this.cleanup(isVhdDistribute, templateName, subscriptionId, storageAccount, containerName, idenityName, principalId, imageRoleDefName);
            }
            catch (error) {
                console.log("E R R O R" + core.setFailed(error));
                tl.setOutput('imagebuilderRunStatus', "failed");
                throw error;
            }
        });
    }
    getTemplateName() {
        if (this._taskParameters.imagebuilderTemplateName) {
            return this._taskParameters.imagebuilderTemplateName;
        }
        return "imagebuilderTemplate" + Utils_1.getCurrentTime();
    }
    uploadPackage(containerName, blobName) {
        return __awaiter(this, void 0, void 0, function* () {
            var defer = Q.defer();
            var archivedWebPackage;
            var temp;
            console.log("this._taskParameters.buildPath " + this._taskParameters.buildPath);
            try {
                if (Utils_2.default.IsEqual(this._taskParameters.provisioner, "powershell")) {
                    archivedWebPackage = yield this.createArchiveTar1(this._taskParameters.buildPath, this._generateTemporaryFile('/home/runner/work/AIB_Action_1/AIB_Action_1/', `.zip`));
                }
                else {
                    archivedWebPackage = yield this.createArchiveTar(this._taskParameters.buildPath, this._generateTemporaryFile('/home/runner/work/AIB_Action_1/AIB_Action_1/', `.tar.gz`));
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
            const createContainerResponse = yield containerClient.create();
            console.log(`Create container ${containerName} successfully`, createContainerResponse.requestId);
            //const content = "Hello world!";
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            var uploadBlobResponse;
            var content = "hello world";
            // uploadBlobResponse = await blockBlobClient.upload(archivedWebPackage, archivedWebPackage.length);
            uploadBlobResponse = yield blockBlobClient.upload(archivedWebPackage, archivedWebPackage.length);
            console.log(`Upload block blob ${blobName} successfully`, uploadBlobResponse.requestId);
            console.log("blockBlobClient.url " + blockBlobClient.url);
            //return blockBlobClient.url;
            defer.resolve(blockBlobClient.url);
            return defer.promise;
        });
    }
    createArchiveTar(folderPath, targetPath) {
        return __awaiter(this, void 0, void 0, function* () {
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
            output.on('error', function (error) {
                defer.reject(error);
            });
            archive.glob("**", {
                cwd: folderPath,
                dot: true
            });
            archive.pipe(output);
            archive.finalize();
            return defer.promise;
        });
    }
    createArchiveTar1(folderPath, targetPath) {
        return __awaiter(this, void 0, void 0, function* () {
            var defer = Q.defer();
            var output = fs.createWriteStream(targetPath);
            var archive = archiver('zip', { zlib: { level: 9 } });
            output.on('close', function () {
                console.log(archive.pointer() + ' total bytes');
                console.log('archiver has been finalized and the output file descriptor has closed.');
                defer.resolve(targetPath);
            });
            archive.on('error', function (err) {
                defer.reject(err);
            });
            archive.glob(folderPath);
            archive.pipe(output);
            // append files from a sub-directory and naming it `new-subdir` within the archive (see docs for more options):
            //archive.directory(source_dir, false);
            archive.finalize();
            return defer.promise;
        });
    }
    _generateTemporaryFile(folderPath, extension) {
        var randomString = Math.random().toString().split('.')[1];
        var tempPath = path.join(folderPath, 'temp_web_package_' + randomString + extension);
        return tempPath;
    }
    executeAzCliCommand(command, options) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                return yield exec.exec(`"${azPath}" ${command}`, [], options);
            }
            catch (error) {
                throw new Error(error);
            }
        });
    }
    cleanup(isVhdDistribute, templateName, subscriptionId, storageAccount, containerName, idenityName, principalId, imageRoleDefName) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                if (!isVhdDistribute) {
                    // Promise.all([this._aibClient.deleteTemplate(templateName, subscriptionId), this.deleteBlob(containerName, blobName)]);
                    yield this._aibClient.deleteTemplate(templateName, subscriptionId);
                }
                yield this.executeAzCliCommand(`role assignment create --assignee-object-id ${principalId} --role "Storage Blob Data Reader" --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${storageAccount}/blobServices/default/containers/${containerName}`);
                console.log("role assignment for storage account deleted");
                let httpRequest = {
                    method: 'DELETE',
                    uri: this._client.getRequestUri(`subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts/{storageAccount}`, { '{subscriptionId}': subscriptionId, '{resourceGroupName}': this._taskParameters.resourceGroupName, '{storageAccount}': storageAccount }, [], "2019-06-01")
                };
                var response = yield this._client.beginRequest(httpRequest);
                console.log("response from delete " + response.statusMessage + " code " + response.statusCode + "   status " + response.body.status);
                console.log("storage account " + storageAccount + " deleted");
                yield this.executeAzCliCommand(`role assignment delete --assignee ${principalId} --role ${imageRoleDefName} --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}`);
                console.log("role assignment deleted");
                yield this.executeAzCliCommand(`identity delete -n ${idenityName} -g ${this._taskParameters.resourceGroupName}`);
                console.log("identity " + idenityName + " deleted");
            }
            catch (error) {
                console.log(`Error in cleanup: `, error);
            }
        });
    }
    getExecuteOptions() {
        var outStream = '';
        var execOptions = {
            outStream: new Utils_1.NullOutstreamStringWritable({ decodeStrings: false }),
            listeners: {
                stdout: (data) => outStream += data.toString()
            }
        };
        return execOptions;
    }
}
exports.default = ImageBuilder;
