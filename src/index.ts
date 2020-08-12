import ImageBuilder from './ImageBuilder';
import { AuthorizerFactory } from "azure-actions-webclient/AuthorizerFactory";

async function main() : Promise<void>{
    let azureResourceAuthorizer = await AuthorizerFactory.getAuthorizer();
    var ib = new ImageBuilder(azureResourceAuthorizer);
    await ib.execute();
}

// run().then()
//      .catch((error) => tl.error(tl.error.name));
main();

