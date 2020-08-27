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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const tl = __importStar(require("@actions/core"));
const constants = __importStar(require("./constants"));
const Utils_1 = __importDefault(require("./Utils"));
var fs = require('fs');
class TaskParameters {
    constructor() {
        this.location = "";
        this.isTemplateJsonProvided = false;
        this.templateJsonFromUser = '';
        this.buildTimeoutInMinutes = 80;
        this.vmSize = "";
        this.managedIdentity = "";
        this.sourceResourceId = "";
        this.imageVersionId = "";
        this.baseImageVersion = "";
        this.imagePublisher = "";
        this.imageOffer = "";
        this.imageSku = "";
        //customize
        this.buildPath = "";
        this.buildFolder = "";
        this.blobName = "";
        this.provisioner = "";
        //??
        this.storageAccountName = "";
        this.customizerSource = "";
        //public customizerDestination: string = "";
        this.customizerScript = "";
        this.customizerWindowsUpdate = "";
        this.imageIdForDistribute = "";
        this.replicationRegions = "";
        this.managedImageLocation = "";
        this.galleryImageId = "";
        var locations = ["eastus", "eastus2", "westcentralus", "westus", "westus2", "northeurope", "westeurope"];
        // general inputs
        console.log("start reading task parameters...");
        this.location = tl.getInput(constants.Location, { required: true });
        if (!(locations.indexOf(this.location.toString().replace(/\s/g, "").toLowerCase()) > -1)) {
            throw new Error("location not from available regions or it is not defined");
        }
        this.resourceGroupName = tl.getInput(constants.ResourceGroupName, { required: true });
        this.managedIdentity = tl.getInput(constants.ManagedIdentity, { required: true });
        this.imagebuilderTemplateName = tl.getInput(constants.ImageBuilderTemplateName);
        if (this.imagebuilderTemplateName.indexOf("json") > -1) {
            this.isTemplateJsonProvided = true;
            var data = fs.readFileSync(this.imagebuilderTemplateName, 'utf8');
            this.templateJsonFromUser = JSON.parse(JSON.stringify(data));
            console.log(this.templateJsonFromUser);
        }
        this.nowaitMode = tl.getInput(constants.NoWaitMode);
        this.buildTimeoutInMinutes = parseInt(tl.getInput(constants.BuildTimeoutInMinutes));
        //vm size
        this.vmSize = tl.getInput(constants.VMSize);
        if (this.vmSize == undefined || this.vmSize == "") {
            this.vmSize = "Standard_D1_v2";
        }
        //source inputs
        this.sourceImageType = tl.getInput(constants.SourceImageType);
        this.sourceOSType = tl.getInput(constants.SourceOSType, { required: true });
        const sourceImage = tl.getInput(constants.SourceImage, { required: true });
        if (Utils_1.default.IsEqual(this.sourceImageType, constants.marketPlaceSourceTypeImage) || Utils_1.default.IsEqual(this.sourceImageType, constants.platformImageSourceTypeImage)) {
            this.sourceImageType = constants.marketPlaceSourceTypeImage;
            this._extractImageDetails(sourceImage);
        }
        else if (Utils_1.default.IsEqual(this.sourceImageType, constants.managedImageSourceTypeImage)) {
            this.sourceResourceId = sourceImage;
        }
        else {
            this.imageVersionId = sourceImage;
        }
        //customize inputs
        this.customizerSource = tl.getInput(constants.CustomizerSource).toString();
        if (this.customizerSource == undefined || this.customizerSource == "" || this.customizerSource == null) {
            var artifactsPath = path.join(`${process.env.GITHUB_WORKSPACE}`, "imageArtifacts");
            if (fs.existsSync(artifactsPath)) {
                this.customizerSource = artifactsPath;
            }
        }
        if (!(this.customizerSource == undefined || this.customizerSource == '' || this.customizerSource == null)) {
            var bp = this.customizerSource;
            var x = bp.split(path.sep);
            this.buildFolder = x[x.length - 1].split(".")[0];
            this.buildPath = path.normalize(bp.trim());
            console.log("Customizer source: " + this.customizerSource);
            console.log("Artifacts folder: " + this.buildFolder);
        }
        this.customizerScript = tl.getInput(constants.customizerScript).toString();
        if (Utils_1.default.IsEqual(this.sourceOSType, "windows")) {
            this.provisioner = "powershell";
        }
        else {
            this.provisioner = "shell";
        }
        this.inlineScript = tl.getInput(constants.customizerScript);
        if (Utils_1.default.IsEqual(tl.getInput(constants.customizerWindowsUpdate), "true")) {
            this.windowsUpdateProvisioner = true;
        }
        else {
            this.windowsUpdateProvisioner = false;
        }
        //distribute inputs
        this.distributeType = tl.getInput(constants.DistributeType, { required: true });
        if (!this.distributeType)
            throw Error("distribute type is required");
        const distResourceId = tl.getInput(constants.DistResourceId);
        if (!Utils_1.default.IsEqual(this.distributeType, "VHD")) {
            throw Error("Distributor Resource Id is required");
        }
        const distLocation = tl.getInput(constants.DistLocation);
        if (Utils_1.default.IsEqual(this.distributeType, constants.managedImageSourceTypeImage)) {
            this.imageIdForDistribute = distResourceId;
            this.managedImageLocation = distLocation;
        }
        else if (Utils_1.default.IsEqual(this.distributeType, constants.sharedImageGallerySourceTypeImage)) {
            this.galleryImageId = distResourceId;
            this.replicationRegions = distLocation;
        }
        this.runOutputName = tl.getInput(constants.RunOutputName);
        console.log("end reading parameters");
    }
    _extractImageDetails(img) {
        this.imagePublisher = "";
        this.imageOffer = "";
        this.imageSku = "";
        this.baseImageVersion;
        var parts = img.split(':');
        if (parts.length != 4) {
            throw Error("Platform Base Image should have '{publisher}:{offer}:{sku}:{version}'. All fields are required.");
        }
        this.imagePublisher = parts[0];
        this.imageOffer = parts[1];
        this.imageSku = parts[2];
        this.baseImageVersion = parts[3];
    }
}
exports.default = TaskParameters;
