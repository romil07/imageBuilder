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
var defaultPublisher = "Publisher:Offer:Sku";
class TaskParameters {
    constructor() {
        this.location = "";
        this.vmSize = "";
        this.sourceResourceId = " ";
        this.imageVersionId = " ";
        this.baseImageVersion = " ";
        this.imagePublisher = " ";
        this.imageOffer = " ";
        this.imageSku = " ";
        this.blobName = "";
        this.provisioner = " ";
        //??
        this.storageAccountName = " ";
        this.customizerSource = " ";
        this.customizerDestination = " ";
        this.customizerScript = " ";
        this.customizerWindowsUpdate = " ";
        this.imageIdForDistribute = " ";
        this.replicationRegions = " ";
        this.managedImageLocation = " ";
        this.galleryImageId = " ";
        var locations = ["eastus", "eastus2", "westcentralus", "westus", "westus2", "northeurope", "westeurope"];
        // generl inputs
        console.log("start reading task parameters...");
        this.location = tl.getInput(constants.Location, { required: true });
        if (!(locations.indexOf(this.location.toString()) > -1)) {
            throw new Error("location not from available regions or it is not defined");
        }
        this.resourceGroupName = tl.getInput(constants.ResourceGroupName);
        this.imagebuilderTemplateName = tl.getInput(constants.ImageBuilderTemplateName);
        this.nowaitMode = tl.getInput(constants.NoWaitMode);
        this.buildTimeoutInMinutes = tl.getInput(constants.BuildTimeoutInMinutes);
        //vm size
        //this.vmSize = tl.getInput(constants.VMSize);
        //source inputs
        this.sourceImageType = tl.getInput(constants.SourceImageType);
        this.sourceOSType = tl.getInput(constants.SourceOSType);
        const sourceImage = tl.getInput(constants.SourceImage);
        // if (Utils.IsEqual(this.sourceImageType, constants.marketPlaceSourceTypeImage) || Utils.IsEqual(this.sourceImageType, constants.platformImageSourceTypeImage)) {
        if (this.sourceImageType == "marketplace") {
            this.sourceImageType = constants.marketPlaceSourceTypeImage;
            this._extractImageDetails(sourceImage);
        }
        // else if (Utils.IsEqual(this.sourceImageType, constants.managedImageSourceTypeImage)) {
        else if (this.sourceImageType == "ManagedImage") {
            this.imageVersionId = sourceImage;
        }
        else {
            this.sourceResourceId = sourceImage;
        }
        //customize inputs
        var bp = tl.getInput(constants.CustomizerSource).toString();
        var x = bp.split(path.sep);
        this.buildFolder = x[x.length - 1];
        this.buildPath = path.normalize(bp.trim());
        console.log("found build at: ", this.buildPath + " and build folder is" + this.buildFolder);
        this.customizerDestination = tl.getInput(constants.customizerDestination);
        //customizerDestination default value =linux or dependent on sourceostype??
        if (this.customizerDestination == null || this.customizerDestination == undefined || this.customizerDestination.length == 0) {
            this.customizerDestination = this.sourceOSType;
        }
        if (this.customizerDestination.toLowerCase() === "windows") {
            this.provisioner = "powershell";
        }
        else {
            this.provisioner = "shell";
        }
        this.inlineScript = tl.getInput(constants.customizerScript);
        if (tl.getInput(constants.customizerWindowsUpdate) == "true") {
            this.windowsUpdateProvisioner = true;
        }
        else {
            this.windowsUpdateProvisioner = false;
        }
        // this.windowsUpdateProvisioner = Boolean(tl.getInput(constants.customizerWindowsUpdate));
        //distribute inputs
        this.distributeType = tl.getInput(constants.DistributeType);
        const distResourceId = tl.getInput(constants.DistResourceId);
        const distLocation = tl.getInput(constants.DistLocation);
        if (Utils_1.default.IsEqual(this.distributeType, constants.managedImageSourceTypeImage)) {
            // if (this.distributeType == "ManagedImage") {
            this.imageIdForDistribute = distResourceId;
            this.managedImageLocation = distLocation;
        }
        else if (Utils_1.default.IsEqual(this.distributeType, constants.sharedImageGallerySourceTypeImage)) {
            // else {
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
        if (parts.length != 4)
            throw Error("Platform Base Image should have '{publisher}:{offer}:{sku}:{version}'. All fields are required.");
        this.imagePublisher = parts[0];
        this.imageOffer = parts[1];
        this.imageSku = parts[2];
        this.baseImageVersion = parts[3];
        console.log("SOURCE  IMAGE " + this.imagePublisher + " " + this.imageOffer + " " + this.imageSku + " " + this.baseImageVersion);
    }
}
exports.default = TaskParameters;
