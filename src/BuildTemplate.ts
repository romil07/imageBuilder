"use strict";
import TaskParameters from "./TaskParameters";
import Utils from "./Utils";
import { IAuthorizer } from 'azure-actions-webclient/Authorizer/IAuthorizer';
import { WebRequest } from 'azure-actions-webclient/WebClient';
import { ServiceClient as AzureRestClient, ToError, AzureError } from 'azure-actions-webclient/AzureRestClient';

var defaultTemplate = `
{
    "location": "",
    "identity": {
        "type": "UserAssigned",
        "userAssignedIdentities": {
            "IDENTITY": {}
        }
    },
    "properties": {
      "source": SOURCE,
      "customize": [CUSTOMIZE],
      "distribute": [DISTRIBUTE],
      "vmProfile": {
          "vmSize": "Standard_D1_v2",
          "osDiskSizeGB": 136 
        }
    }
  }
`
var templateSource = new Map([
    ["managedimage", `{"type": "ManagedImage", "imageId": "IMAGE_ID"}`],
    ["sharedgalleryimage", `{"type": "SharedImageVersion", "imageVersionId": "IMAGE_ID"}`],
    ["marketplace", `{"type": "PlatformImage", "publisher": "PUBLISHER_NAME", "offer": "OFFER_NAME","sku": "SKU_NAME", "version": "VERSION"}`]
])

var templateCustomizer = new Map([
    ["shell", `{"type": "File", "name": "vststask_file_copy", "sourceUri": "", "destination": ""},{"type": "Shell", "name": "vststask_inline", "inline":[]}`],
    ["powershell", `{"type": "PowerShell", "name": "vststask_inline", "inline":[]}`],
    ["windowsUpdate", `{"type": "PowerShell", "name": "5minWait_is_needed_before_windowsUpdate", "inline":["Start-Sleep -Seconds 300"]},{"type": "WindowsUpdate", "searchCriteria": "IsInstalled=0", "filters": ["exclude:$_.Title -like '*Preview*'", "include:$true"]}`]
])

var templateDistribute = new Map([
    ["managedimage", `{"type": "ManagedImage", "imageId": "IMAGE_ID", "location": "", "runOutputName": "ManagedImage_distribute"}`],
    ["sharedgalleryimage", `{"type": "SharedImage", "galleryImageId": "IMAGE_ID", "replicationRegions": [], "runOutputName": "SharedImage_distribute"}`],
    ["vhd", `{"type": "VHD", "runOutputName": "VHD_distribute"}`]
])

export default class BuildTemplate
{
    private _taskParameters: TaskParameters;
    private _client: AzureRestClient;

    constructor(resourceAuthorizer: IAuthorizer,  taskParameters: TaskParameters) 
    {
        try{
            this._taskParameters = taskParameters;
            this._client = new AzureRestClient(resourceAuthorizer);
        }
        catch(error)
        {
            throw Error(`error happened while initializing Image builder: ${error}`);
        }
    }

    private async getLatestVersion(subscriptionId: string): Promise<string>
    {
        let httpRequest: WebRequest = {
            method: 'GET',
            uri: this._client.getRequestUri(`/subscriptions/{subscriptionId}/providers/Microsoft.Compute/locations/{location}/publishers/{publisherName}/artifacttypes/vmimage/offers/{offer}/skus/{skus}/versions`,{'{subscriptionId}': subscriptionId,'{location}': this._taskParameters.location,'{publisherName}': this._taskParameters.imagePublisher, '{offer}': this._taskParameters.imageOffer, '{skus}': this._taskParameters.imageSku }, ["$orderby=name%20desc", "$top=1"], '2018-06-01')
        };
        console.log("http "+httpRequest.uri);
        var latestVersion: string = "";
        try {
            var response = await this._client.beginRequest(httpRequest);
            if(response.statusCode != 200 || response.body.statusCode == "Failed")
                throw ToError(response);

            if(response.statusCode == 200 && response.body)
                latestVersion = response.body[0].name;
        }
        catch(error) {
            
            if (error instanceof AzureError) {
                throw new Error(JSON.stringify(error));
            }
            
            throw error;
        }
        return latestVersion;
    }

    public async getTemplate(blobUrl: string, imgBuilderId: string, subscriptionId: string) : Promise<any>
    {
        var template = defaultTemplate
        //we need to create ??
        template = template.replace("IDENTITY", imgBuilderId);
        //template = template.replace("VM_SIZE", this._taskParameters.vmSize);
        template = template.replace("SOURCE", <string>templateSource.get(this._taskParameters.sourceImageType.toLowerCase()));
        template = template.replace("DISTRIBUTE", <string>templateDistribute.get(this._taskParameters.distributeType.toLowerCase()));
        //no input like provisioner in github actions
        var customizers = templateCustomizer.get(this._taskParameters.provisioner);
        // add windows update
        console.log("this._taskParameters.windowsUpdateProvisioner "+this._taskParameters.windowsUpdateProvisioner);
        if(Utils.IsEqual(this._taskParameters.provisioner, "powershell") && this._taskParameters.windowsUpdateProvisioner)
            customizers = customizers + "," + templateCustomizer.get("windowsUpdate");
        template = template.replace("CUSTOMIZE", <string>customizers);

        var templateJson = JSON.parse(template);
        templateJson.location = this._taskParameters.location;
        if(Utils.IsEqual(templateJson.properties.source.type, "PlatformImage"))
        {
            templateJson.properties.source.publisher = this._taskParameters.imagePublisher;
            templateJson.properties.source.offer = this._taskParameters.imageOffer;
            templateJson.properties.source.sku = this._taskParameters.imageSku;
            if(Utils.IsEqual(this._taskParameters.baseImageVersion, "latest"))
                templateJson.properties.source.version = await this.getLatestVersion(subscriptionId);
            else
                templateJson.properties.source.version = this._taskParameters.baseImageVersion
        }
        else if(Utils.IsEqual(templateJson.properties.source.type, "ManagedImage"))
            templateJson.properties.source.imageId = this._taskParameters.sourceResourceId;
        else 
            templateJson.properties.source.imageVersionId = this._taskParameters.imageVersionId;
        console.log("Source for image: ", templateJson.properties.source);

        // customize
        if(Utils.IsEqual(this._taskParameters.provisioner, "shell"))
        {
            var inline: string = "#\n";
            
            var packageName = `/tmp/${this._taskParameters.buildFolder}`;
            templateJson.properties.customize[0].sourceUri = blobUrl;
            templateJson.properties.customize[0].destination = `${packageName}.tar.gz`;
            inline += `mkdir -p ${packageName}\n`
            inline += `sudo tar -xzvf ${templateJson.properties.customize[0].destination} -C ${packageName}\n`
            if(this._taskParameters.inlineScript)
                inline += `${this._taskParameters.inlineScript}\n`;
            templateJson.properties.customize[1].inline = inline.split("\n");
        }
        else if(Utils.IsEqual(this._taskParameters.provisioner, "powershell")){
            var packageName = "c:\\buildartifacts\\" + this._taskParameters.buildFolder;
            // create buildartifacts folder
            var inline = `New-item -Path c:\\buildartifacts -itemtype directory\n`
            // download zip
            inline += `Invoke-WebRequest -Uri '${blobUrl}' -OutFile ${packageName}.zip -UseBasicParsing\n`
            // unzip
            inline += `Expand-Archive -Path ${packageName}.zip -DestinationPath ${packageName}\n`
            if(this._taskParameters.inlineScript)
                inline += `${this._taskParameters.inlineScript}\n`;
            templateJson.properties.customize[0].inline = inline.split("\n");
        }

        if(Utils.IsEqual(templateJson.properties.distribute[0].type, "ManagedImage"))
        {
            templateJson.properties.distribute[0].imageId = this._taskParameters.imageIdForDistribute;
            templateJson.properties.distribute[0].location = this._taskParameters.managedImageLocation;
        }

        if(Utils.IsEqual(templateJson.properties.distribute[0].type, "SharedImage"))
        {
            templateJson.properties.distribute[0].galleryImageId = this._taskParameters.galleryImageId;
            var regions = this._taskParameters.replicationRegions.split(",");
            templateJson.properties.distribute[0].replicationRegions = regions;
        }

        return templateJson;
    }
}