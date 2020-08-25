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
const core = __importStar(require("@actions/core"));
const exec = __importStar(require("@actions/exec"));
const io = __importStar(require("@actions/io"));
const TaskParameters_1 = __importDefault(require("./TaskParameters"));
const Utils_1 = require("./Utils");
const AzureImageBuilderClient_1 = __importDefault(require("./AzureImageBuilderClient"));
const BuildTemplate_1 = __importDefault(require("./BuildTemplate"));
const Util = require("util");
const Utils_2 = __importDefault(require("./Utils"));
var fs = require('fs');
var archiver = require('archiver');
const constants = __importStar(require("./constants"));
const AzureRestClient_1 = require("azure-actions-webclient/AzureRestClient");
var azure = require('azure-storage');
var azPath;
var storageAccountExists = false;
class ImageBuilder {
    constructor(resourceAuthorizer) {
        this.subscriptionId = "";
        this.isVhdDistribute = false;
        this.templateName = "";
        this.storageAccount = "";
        this.containerName = "";
        this.idenityName = "";
        this.imgBuilderTemplateExists = false;
        this.accountkeys = "";
        try {
            this._taskParameters = new TaskParameters_1.default();
            this._buildTemplate = new BuildTemplate_1.default(resourceAuthorizer, this._taskParameters);
            this._aibClient = new AzureImageBuilderClient_1.default(resourceAuthorizer, this._taskParameters);
            this._client = new AzureRestClient_1.ServiceClient(resourceAuthorizer);
            this.idenityName = this._taskParameters.managedIdentity;
        }
        catch (error) {
            throw (`error happened while initializing Image builder: ${error}`);
        }
    }
    execute() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                var outStream;
                azPath = yield io.which("az", true);
                core.debug("Az module path: " + azPath);
                yield this.executeAzCliCommand("--version");
                yield this.registerFeatures();
                this.sleepFor(2);
                //GENERAL INPUTS
                outStream = yield this.executeAzCliCommand("account show");
                this.subscriptionId = JSON.parse(`${outStream}`).id.toString();
                var isCreateBlob = false;
                var imgBuilderId = "";
                console.log("template json provided " + this._taskParameters.isTemplateJsonProvided);
                if (!this._taskParameters.isTemplateJsonProvided) {
                    outStream = JSON.parse(yield this.executeAzCliCommand(`identity show --resource-group ${this._taskParameters.resourceGroupName} --name ${this.idenityName}`));
                    if (outStream != undefined) {
                        imgBuilderId = outStream.id;
                    }
                }
                if (this._taskParameters.customizerSource != undefined && this._taskParameters.customizerSource != '' && this._taskParameters.customizerSource != null && this._taskParameters.customizerSource.length >= 1) {
                    isCreateBlob = true;
                }
                var blobUrl = "";
                if (isCreateBlob) {
                    yield this.createStorageAccount();
                    this.sleepFor(2);
                    //create a blob service
                    this._blobService = azure.createBlobService(this.storageAccount, this.accountkeys);
                    this.containerName = constants.containerName;
                    var blobName = this._taskParameters.buildFolder + "/" + process.env.GITHUB_RUN_ID + "/" + this._taskParameters.buildFolder + `_${Utils_1.getCurrentTime()}`;
                    if (Utils_2.default.IsEqual(this._taskParameters.provisioner, "powershell"))
                        blobName = blobName + '.zip';
                    else
                        blobName = blobName + '.tar.gz';
                    blobUrl = yield this.uploadPackage(blobName);
                    core.debug("Blob Url: " + blobUrl);
                }
                let templateJson = "";
                if (!this._taskParameters.isTemplateJsonProvided) {
                    //create template
                    core.debug("Creating image template");
                    templateJson = yield this._buildTemplate.getTemplate(blobUrl, imgBuilderId, this.subscriptionId);
                }
                else {
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
                yield this._aibClient.putImageTemplate(templateStr, this.templateName, this.subscriptionId);
                //we should delete it after run or put template??????????????
                //this.imgBuilderTemplateExists = true;
                yield this._aibClient.runTemplate(this.templateName, this.subscriptionId, this._taskParameters.buildTimeoutInMinutes);
                this.imgBuilderTemplateExists = true;
                var out = yield this._aibClient.getRunOutput(this.templateName, runOutputName, this.subscriptionId);
                var templateID = yield this._aibClient.getTemplateId(this.templateName, this.subscriptionId);
                core.setOutput('templateName', this.templateName);
                core.setOutput('templateId', templateID);
                if (out) {
                    core.setOutput('customImageURI', out);
                    core.setOutput('imagebuilderRunStatus', "succeeded");
                }
                if (Utils_2.default.IsEqual(templateJson.properties.source.type, "PlatformImage")) {
                    core.setOutput('pirPublisher', templateJson.properties.source.publisher);
                    core.setOutput('pirOffer', templateJson.properties.source.offer);
                    core.setOutput('pirSku', templateJson.properties.source.sku);
                    core.setOutput('pirVersion', templateJson.properties.source.version);
                }
                console.log("==============================================================================");
                console.log("## task output variables ##");
                console.log("$(imageUri) = ", out);
                if (this.isVhdDistribute) {
                    console.log("$(templateName) = ", this.templateName);
                    console.log("$(templateId) = ", templateID);
                }
                console.log("==============================================================================");
            }
            catch (error) {
                throw error;
            }
            finally {
                outStream = yield this.executeAzCliCommand(`group exists -n ${this._taskParameters.resourceGroupName}`);
                if (outStream) {
                    this.cleanup();
                }
            }
        });
    }
    addUserCustomisationIfNeeded(blobUrl) {
        var json = JSON.parse(this._taskParameters.templateJsonFromUser);
        var customizers = json.properties.customize;
        var shellCustomizer;
        // add customization for custom scripts
        if (!!this._taskParameters.customizerScript) {
            if (Utils_2.default.IsEqual(this._taskParameters.sourceOSType, "Windows")) {
                shellCustomizer = {
                    "type": "PowerShell",
                    "name": "CustomPowershell" + Utils_1.getCurrentTime(),
                    "inline": [
                        this._taskParameters.customizerScript
                    ]
                };
            }
            else {
                shellCustomizer = {
                    "type": "Shell",
                    "name": "CustomShell" + Utils_1.getCurrentTime(),
                    "inline": [
                        this._taskParameters.customizerScript
                    ]
                };
            }
        }
        // add customization for custom source
        var fileCustomizer;
        if (!!this._taskParameters.customizerSource) {
            fileCustomizer = {
                "type": "File",
                "name": "CustomSource" + Utils_1.getCurrentTime(),
                "sourceUri": blobUrl,
                "destination": this._taskParameters.customizerDestination
            };
        }
        if (fileCustomizer != null && fileCustomizer !== undefined)
            customizers.unshift(fileCustomizer);
        if (shellCustomizer != null && shellCustomizer !== undefined)
            customizers.unshift(shellCustomizer);
        json.properties.customize = customizers;
        return json;
    }
    createStorageAccount() {
        return __awaiter(this, void 0, void 0, function* () {
            this.storageAccount = Util.format('%s%s', constants.storageAccountName, Utils_1.getCurrentTime());
            yield this.executeAzCliCommand(`storage account create --name "${this.storageAccount}" --resource-group "${this._taskParameters.resourceGroupName}" --location "${this._taskParameters.location}" --sku Standard_RAGRS`);
            core.debug("Created storage account " + this.storageAccount);
            var outStream = yield this.executeAzCliCommand(`storage account keys list -g "${this._taskParameters.resourceGroupName}" -n "${this.storageAccount}"`);
            this.accountkeys = JSON.parse(`${outStream}`)[0].value;
            storageAccountExists = true;
        });
    }
    registerFeatures() {
        return __awaiter(this, void 0, void 0, function* () {
            var outStream = yield this.executeAzCliCommand(`feature show --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview`);
            if (JSON.parse(outStream) && !Utils_2.default.IsEqual(JSON.parse(outStream).properties.state, "Registered")) {
                core.info("Registering Microsoft.VirtualMachineImages");
                yield this.executeAzCliCommand("feature register --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview");
                outStream = yield this.executeAzCliCommand(`feature show --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview`);
                while (!Utils_2.default.IsEqual(JSON.parse(outStream).properties.state, "Registered")) {
                    this.sleepFor(1);
                    outStream = yield this.executeAzCliCommand(`feature show --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview`);
                }
            }
            outStream = '';
            outStream = yield this.executeAzCliCommand(`provider show -n Microsoft.VirtualMachineImages`);
            if (JSON.parse(outStream) && !Utils_2.default.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
                yield this.executeAzCliCommand("provider register -n Microsoft.VirtualMachineImages");
                outStream = yield this.executeAzCliCommand(`provider show -n Microsoft.VirtualMachineImages`);
                while (JSON.parse(outStream) && !Utils_2.default.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
                    this.sleepFor(1);
                    outStream = yield this.executeAzCliCommand(`provider show -n Microsoft.VirtualMachineImages`);
                }
            }
            outStream = '';
            outStream = yield this.executeAzCliCommand(`provider show -n Microsoft.Storage`);
            if (JSON.parse(outStream) && !Utils_2.default.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
                core.info("Registering Microsoft.Storage");
                yield this.executeAzCliCommand("provider register -n Microsoft.Storage");
                outStream = yield this.executeAzCliCommand(`provider show -n Microsoft.Storage`);
                while (JSON.parse(outStream) && !Utils_2.default.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
                    this.sleepFor(1);
                    outStream = yield this.executeAzCliCommand(`provider show -n Microsoft.Storage`);
                }
            }
            outStream = '';
            outStream = yield this.executeAzCliCommand(`provider show -n Microsoft.Compute`);
            if (JSON.parse(outStream) && !Utils_2.default.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
                core.info("Registering Microsoft.Compute");
                yield this.executeAzCliCommand("provider register -n Microsoft.Compute");
                outStream = yield this.executeAzCliCommand(`provider show -n Microsoft.Compute`);
                while (JSON.parse(outStream) && !Utils_2.default.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
                    this.sleepFor(1);
                    outStream = yield this.executeAzCliCommand(`provider show -n Microsoft.Compute`);
                }
            }
            outStream = '';
            outStream = yield this.executeAzCliCommand(`provider show -n Microsoft.KeyVault`);
            if (JSON.parse(outStream) && !Utils_2.default.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
                core.info("Registering Microsoft.KeyVault");
                yield this.executeAzCliCommand("provider register -n Microsoft.KeyVault");
                outStream = yield this.executeAzCliCommand(`provider show -n Microsoft.KeyVault`);
                while (JSON.parse(outStream) && !Utils_2.default.IsEqual(JSON.parse(outStream).registrationState, "Registered")) {
                    this.sleepFor(1);
                    outStream = yield this.executeAzCliCommand(`provider show -n Microsoft.KeyVault`);
                }
            }
        });
    }
    getTemplateName() {
        if (this._taskParameters.isTemplateJsonProvided) {
            var name = this.getTemplateNameFromProvidedJson();
            return name == "" ? constants.imageTemplateName + Utils_1.getCurrentTime() : name;
        }
        else if (!this._taskParameters.isTemplateJsonProvided && this._taskParameters.imagebuilderTemplateName) {
            return this._taskParameters.imagebuilderTemplateName;
        }
        return constants.imageTemplateName + Utils_1.getCurrentTime();
    }
    getTemplateNameFromProvidedJson() {
        var template = JSON.parse(this._taskParameters.templateJsonFromUser);
        if (template.tags && template.tags.imagebuilderTemplate) {
            return template.tags.imagebuilderTemplate;
        }
        return "";
    }
    uploadPackage(blobName) {
        return __awaiter(this, void 0, void 0, function* () {
            var defer = Q.defer();
            var archivedWebPackage;
            var temp = this._generateTemporaryFile(`${process.env.GITHUB_WORKSPACE}`);
            try {
                if (Utils_2.default.IsEqual(this._taskParameters.provisioner, "powershell")) {
                    temp = temp + `.zip`;
                    archivedWebPackage = yield this.createArchiveTar(this._taskParameters.buildPath, temp, "zip");
                }
                else {
                    temp = temp + `.tar.gz`;
                    archivedWebPackage = yield this.createArchiveTar(this._taskParameters.buildPath, temp, "tar");
                }
            }
            catch (error) {
                defer.reject(console.log(`unable to create archive build: ${error}`));
            }
            console.log(`created  archive ` + archivedWebPackage);
            this._blobService.createContainerIfNotExists(this.containerName, (error) => {
                if (error) {
                    defer.reject(console.log(`unable to create container ${this.containerName} in storage account: ${error}`));
                }
                //upoading package
                this._blobService.createBlockBlobFromLocalFile(this.containerName, blobName, archivedWebPackage, (error, result) => {
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
        });
    }
    createArchiveTar(sourcePath, targetPath, extension) {
        return __awaiter(this, void 0, void 0, function* () {
            var defer = Q.defer();
            console.log('Archiving ' + sourcePath + ' to ' + targetPath);
            var output = fs.createWriteStream(targetPath);
            var archive;
            if (Utils_2.default.IsEqual(extension, 'zip')) {
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
            output.on('error', function (error) {
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
        });
    }
    _generateTemporaryFile(folderPath) {
        var randomString = Math.random().toString().split('.')[1];
        var tempPath = path.join(folderPath, '/temp_web_package_' + randomString);
        return tempPath;
    }
    cleanup() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                if (!this.isVhdDistribute && this.imgBuilderTemplateExists) {
                    yield this._aibClient.deleteTemplate(this.templateName, this.subscriptionId);
                    console.log(`${this.templateName} got deleted`);
                }
                if (storageAccountExists) {
                    let httpRequest = {
                        method: 'DELETE',
                        uri: this._client.getRequestUri(`subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts/{storageAccount}`, { '{subscriptionId}': this.subscriptionId, '{resourceGroupName}': this._taskParameters.resourceGroupName, '{storageAccount}': this.storageAccount }, [], "2019-06-01")
                    };
                    var response = yield this._client.beginRequest(httpRequest);
                    console.log("storage account " + this.storageAccount + " deleted");
                }
            }
            catch (error) {
                console.log(`Error in cleanup: `, error);
            }
        });
    }
    executeAzCliCommand(command) {
        return __awaiter(this, void 0, void 0, function* () {
            var outStream = '';
            console.log("command " + command);
            var execOptions = {
                outStream: new Utils_1.NullOutstreamStringWritable({ decodeStrings: false }),
                listeners: {
                    stdout: (data) => outStream += data.toString(),
                }
            };
            try {
                yield exec.exec(`"${azPath}" ${command}`, [], execOptions);
                return outStream;
            }
            catch (error) {
                throw error;
            }
        });
    }
    sleepFor(sleepDurationInSeconds) {
        return new Promise((resolve, reeject) => {
            setTimeout(resolve, sleepDurationInSeconds * 1000);
        });
    }
}
exports.default = ImageBuilder;
