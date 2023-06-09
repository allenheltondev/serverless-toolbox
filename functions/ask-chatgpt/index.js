const { Configuration, OpenAIApi } = require('openai');
const { CacheClient, CredentialProvider, Configurations, CacheListFetch } = require('@gomomento/sdk');
const shared = require('/opt/nodejs/index');

let cacheClient;
let openai;

exports.handler = async (state) => {
  let messages = [];
  await initialize();

  if (state.conversationKey) {
    const previousMessageResponse = await cacheClient.listFetch('chatgpt', state.conversationKey);
    if (previousMessageResponse instanceof CacheListFetch.Hit) {
      messages = previousMessageResponse.valueListString().map(m => JSON.parse(m));
    }
  }

  if (state.systemContext) {
    messages.push({ role: 'system', content: state.systemContext });
  }

  const newMessage = { role: 'user', content: state.query };
  messages.push(newMessage);

  try {
    const result = await openai.createChatCompletion({
      model: 'gpt-4-0613',
      temperature: .7,
      messages: messages,
      ...state.schema && {
        functions: [{
          name: 'user-schema',
          parameters: state.schema
        }]
      }
    });

    if (state.conversationKey && state.rememberResponse) {
      await cacheClient.listConcatenateBack('chatgpt', state.conversationKey, [JSON.stringify(newMessage), JSON.stringify(result.data.choices[0].message)]);
    }

    let response = result.data.choices[0].message.content;
    if (state.schema) {
      response = result.data.choices[0].message;
      response = JSON.parse(response.function_call.arguments);
      return { response };
    }

    if (state.trim) {
      const pieces = response.split('\n\n');

      if (pieces.length > 2) {
        const removedText = pieces.slice(1, pieces.length - 2);
        response = removedText.join('\n\n');
        if (!response) {
          response = pieces.join('\n\n');
        }
      }
    } else if (state.trimFront) {
      const pieces = response.split('\n\n');
      if (pieces.length > 2) {
        const removedText = pieces.slice(1);
        response = removedText.join('\n\n');
      }
    }

    switch (state.outputFormat?.toLowerCase()) {
      case 'json':
        response = JSON.parse(response);
        break;
      case 'number':
        response = Number(response);
        break;
      default:
        response = response.toString();
        break;
    }


    return { response };
  } catch (err) {
    if (err.response) {
      console.error({ status: err.response.status, data: err.response.data });
      if (err.response.status == 429) {
        function CustomError(message) {
          this.name = 'RateLimitExceeded';
          this.message = message;
        }

        CustomError.prototype = new Error();
        console.log('Throwing RateLimitExceededError')
        throw new CustomError(err.message);
      }
    } else {
      console.error(err.message);
    }

    throw err;
  }
}

const setupOpenAI = async () => {
  if (!openai) {
    const authToken = await shared.getSecret('openai');
    openai = new OpenAIApi(new Configuration({ apiKey: authToken }));
  }
};

const initialize = async () => {
  await setupCacheClient();
  await setupOpenAI();
};

const setupCacheClient = async () => {
  if (!cacheClient) {
    const authToken = await shared.getSecret('momento');

    cacheClient = new CacheClient({
      configuration: Configurations.Laptop.latest(),
      credentialProvider: CredentialProvider.fromString({ authToken }),
      defaultTtlSeconds: Number(process.env.CACHE_TTL)
    });
  }

  return cacheClient;
};