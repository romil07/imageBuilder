import ImageBuilder from './ImageBuilder';
import { AuthorizerFactory } from "azure-actions-webclient/AuthorizerFactory";
import * as core from '@actions/core';

async function main(): Promise<void> {
    let azureResourceAuthorizer = await AuthorizerFactory.getAuthorizer();
    var ib = new ImageBuilder(azureResourceAuthorizer);
    await ib.execute();
}

main().then()
    .catch((error) => {
        core.setOutput('imagebuilderRunStatus', "failed");
        core.setFailed(error);
    });

