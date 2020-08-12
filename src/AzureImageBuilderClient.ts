import TaskParameters from './TaskParameters';
import { IAuthorizer } from 'azure-actions-webclient/Authorizer/IAuthorizer';
import { WebRequest, WebResponse } from 'azure-actions-webclient/WebClient';
import { ServiceClient as AzureRestClient, ToError, AzureError } from 'azure-actions-webclient/AzureRestClient';
import * as core from '@actions/core';

var apiVersion = "2020-02-14";

export default class ImageBuilderClient {

    private _client: AzureRestClient;
    private _taskParameters: TaskParameters;

        constructor(resourceAuthorizer: IAuthorizer,  taskParameters: TaskParameters) {
        this._client = new AzureRestClient(resourceAuthorizer);
        this._taskParameters = taskParameters;
    }

    public async getTemplateId(templateName: string, subscriptionId: string): Promise<string> {
        let httpRequest: WebRequest = {
            method: 'GET',
            uri: this._client.getRequestUri(`/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.VirtualMachineImages/imagetemplates/{imageTemplateName}`, { '{subscriptionId}': subscriptionId, '{resourceGroupName}': this._taskParameters.resourceGroupName, '{imageTemplateName}': templateName }, [], apiVersion)
        };
        var resourceId: string = "";
        try {
            var response = await this._client.beginRequest(httpRequest);
            if (response.statusCode != 200 || response.body.status == "Failed")
                throw ToError(response);

            if (response.statusCode == 200 && response.body.id)
                resourceId = response.body.id;
        }
        catch (error) {
            throw Error(`get template call failed for template ${templateName} with error: `+error.toString());
        }
        return resourceId;
    }

    public async putImageTemplate(template: string, templateName: string, subscriptionId: string) {
        console.log("starting put template...");
        let httpRequest: WebRequest = {
            method: 'PUT',
            uri: this._client.getRequestUri(`/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.VirtualMachineImages/imagetemplates/{imageTemplateName}`, { '{subscriptionId}': subscriptionId, '{resourceGroupName}': this._taskParameters.resourceGroupName, '{imageTemplateName}': templateName }, [], apiVersion),
            body: template
        };
        
        try {
            var response = await this._client.beginRequest(httpRequest);
            console.log("response.statusCode "+response.statusCode+"   msg "+response.statusMessage+"  bodu "+response.body)
            if (response.statusCode == 201) {
                response = await this.getLongRunningOperationResult(response);
            }
            if (response.statusCode != 200 || response.body.status == "Failed") {
                console.log("error in put template ");
                throw ToError(response);
            }
            if (response.statusCode == 200 && response.body && response.body.status == "Succeeded") {
                console.log("put template: ", response.body.status);
            }
        }
        catch (error) {
            throw Error(`put template call failed for template ${templateName} with error: ${error}`);
        }
    }

    /**
     * postTemplate
     */
    public async runTemplate(templateName: string, subscriptionId: string) {
        try {
            console.log("starting run template...");
            let httpRequest: WebRequest = {
                method: 'POST',
                uri: this._client.getRequestUri(`/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.VirtualMachineImages/imagetemplates/{imageTemplateName}/run`, { '{subscriptionId}': subscriptionId, '{resourceGroupName}': this._taskParameters.resourceGroupName, '{imageTemplateName}': templateName }, [], apiVersion)
            };
           
            var response = await this._client.beginRequest(httpRequest);
            if(response.statusCode == 202) {
                response = await this.getLongRunningOperationResult(response);
            }
            if(response.statusCode != 200 || response.body.status == "Failed") {
                throw ToError(response);
            }
            if(response.statusCode == 200 && response.body && response.body.status == "Succeeded") {
                console.log("run template: ", response.body.status);
            }
        }
        catch (error) {
            throw Error(`post template call failed for template ${templateName} with error: ${error}`);
        }
    }

    public async deleteTemplate(templateName: string, subscriptionId: string) {
        try {
            console.log(`deleting template ${templateName}...`);
            let httpRequest: WebRequest = {
                method: 'DELETE',
                uri: this._client.getRequestUri(`/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.VirtualMachineImages/imagetemplates/{imageTemplateName}`, { '{subscriptionId}': subscriptionId, '{resourceGroupName}': this._taskParameters.resourceGroupName, '{imageTemplateName}': templateName }, [], apiVersion)
            };
            var response = await this._client.beginRequest(httpRequest);
            if(response.statusCode == 202) {
                response = await this.getLongRunningOperationResult(response);
            }
            if(response.statusCode != 200 || response.body.status == "Failed") {
                throw ToError(response);
            }

            if(response.statusCode == 200 && response.body && response.body.status == "Succeeded") {
                console.log("delete template: ", response.body.status);
            }
        }
        catch (error) {
            throw Error(`post template call failed for template ${templateName} with error: ${error}`);
        }
    }


    public async getRunOutput(templateName: string, runOutput: string, subscriptionId: string): Promise<string> {
        console.log("getting runOutput for ", runOutput);
        let httpRequest: WebRequest = {
            method: 'GET',
            uri: this._client.getRequestUri(`/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.VirtualMachineImages/imagetemplates/{imageTemplateName}/runOutputs/{runOutput}`, { '{subscriptionId}': subscriptionId, '{resourceGroupName}': this._taskParameters.resourceGroupName, '{imageTemplateName}': templateName, '{runOutput}': runOutput }, [], apiVersion)
        };
        var output: string = "";
        try {
            var response = await this._client.beginRequest(httpRequest);
            if(response.statusCode != 200 || response.body.status == "Failed")
                throw ToError(response);
            if(response.statusCode == 200 && response.body){
                if(response.body && response.body.properties.artifactId)
                    output = response.body.properties.artifactId;
                else if(response.body && response.body.properties.artifactUri)
                    output = response.body.properties.artifactUri;
                else
                    console.log(`Error to parse response.body -- ${response.body}.`);
            }
        }
        catch (error) {
            throw Error(`error happened while initializing Image builder: ${error}`);
        }
        return output;
    }

    public async getLongRunningOperationResult(response :WebResponse, timeoutInMinutes?: number): Promise<WebResponse> {
        var longRunningOperationRetryTimeout = !!timeoutInMinutes ? timeoutInMinutes : 0;
        timeoutInMinutes = timeoutInMinutes || longRunningOperationRetryTimeout;
        var timeout = new Date().getTime() + timeoutInMinutes * 60 * 1000;
        var waitIndefinitely = timeoutInMinutes == 0;
        var requestURI = response.headers["azure-asyncoperation"] || response.headers["location"];
        let httpRequest: WebRequest = {
            method: 'GET',
            uri: requestURI
        };
        if (!httpRequest.uri) {
            throw new Error("InvalidResponseLongRunningOperation");
        }
        
        if (!httpRequest.uri) {
            console.log("ERROR IN URI "+httpRequest.uri);
        }
        while (true) {
            var response = await this._client.beginRequest(httpRequest);
            if (response.statusCode === 202 || (response.body && (response.body.status == "Accepted" || response.body.status == "Running" || response.body.status == "InProgress"))) {
                if(response.body && response.body.status) {
                    core.debug(response.body.status);
                }
                // If timeout; throw;
                if (!waitIndefinitely && timeout < new Date().getTime()) {
                    console.log("ERROR IN URI "+response.body.status);
                }

                // Retry after given interval.
                var sleepDuration = 15;
                await this.sleepFor(sleepDuration);
            } else {
                break;
            }
        }

        return response;
    }

    private sleepFor(sleepDurationInSeconds: any): Promise<any> {
        return new Promise((resolve, reeject) => {
            setTimeout(resolve, sleepDurationInSeconds * 1000);
        });
    }
}