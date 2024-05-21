/* eslint-disable camelcase */
/*
 * Copyright (c) Pretzel AI GmbH.
 * This file is part of the Pretzel project and is licensed under the
 * GNU Affero General Public License version 3.
 * See the LICENSE_AGPLv3 file at the root of the project for the full license text.
 * Contributions by contributors listed in the PRETZEL_CONTRIBUTORS file (found at
 * the root of the project) are licensed under AGPLv3.
 */
/**
 * @packageDocumentation
 * @module pretzelai-extension
 */

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { IIOPubMessage } from '@jupyterlab/services/lib/kernel/messages';
import * as monaco from 'monaco-editor';
import OpenAI from 'openai';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { AzureKeyCredential, OpenAIClient } from '@azure/openai';
import { calculateHash, isSetsEqual, renderEditor } from './utils';
import {
  AiService,
  Embedding,
  generatePrompt,
  getTopSimilarities,
  openaiEmbeddings,
  openAiStream
} from './prompt';
import posthog from 'posthog-js';
import { CodeCellModel } from '@jupyterlab/cells';
import { OutputAreaModel } from '@jupyterlab/outputarea';
import { IOutputModel } from '@jupyterlab/rendermime';
import { initSplashScreen } from './splashScreen';

function initializePosthog(cookiesEnabled: boolean) {
  posthog.init('phc_FnIUQkcrbS8sgtNFHp5kpMkSvL5ydtO1nd9mPllRQqZ', {
    api_host: 'https://d2yfaqny8nshvd.cloudfront.net',
    persistence: cookiesEnabled ? 'localStorage+cookie' : 'memory',
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    mask_all_text: true,
    disable_session_recording: true
  });
}

const PLUGIN_ID = '@jupyterlab/pretzelai-extension:plugin';

const NUMBER_OF_SIMILAR_CELLS = 3;

const extension: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  autoStart: true,
  requires: [ICommandPalette, INotebookTracker, ISettingRegistry],
  activate: async (
    app: JupyterFrontEnd,
    palette: ICommandPalette,
    notebookTracker: INotebookTracker,
    settingRegistry: ISettingRegistry
  ) => {
    const { commands } = app;
    const command = 'pretzelai:replace-code';
    const placeholderDisabled =
      'To use AI features, please set your OpenAI API key or Azure API details in the Pretzel AI Settings.\n' +
      'You can also use the free Pretzel AI server.\n' +
      'Go To: Settings > Settings Editor > Pretzel AI Settings to configure';

    const placeHolderEnabled =
      'Ask AI. Use @variable_name to reference defined variables and dataframes. Shift + Enter for new line.';
    let openAiApiKey = '';
    let openAiBaseUrl = '';
    let aiService: AiService = 'Use Pretzel AI Server';
    let azureBaseUrl = '';
    let azureDeploymentName = '';
    let azureApiKey = '';
    let aiClient: OpenAI | OpenAIClient | null;
    let posthogPromptTelemetry: boolean = true;

    const showSplashScreen = async (consent: string) => {
      if (consent === 'None') {
        initSplashScreen(settingRegistry);
      }
    };

    async function loadSettings(updateFunc?: () => void) {
      try {
        const settings = await settingRegistry.load(PLUGIN_ID);
        const openAiSettings = settings.get('openAiSettings').composite as any;
        openAiApiKey = openAiSettings?.openAiApiKey || '';
        openAiBaseUrl = openAiSettings?.openAiBaseUrl || '';

        const azureSettings = settings.get('azureSettings').composite as any;
        azureBaseUrl = azureSettings?.azureBaseUrl || '';
        azureDeploymentName = azureSettings?.azureDeploymentName || '';
        azureApiKey = azureSettings?.azureApiKey || '';

        const aiServiceSetting = settings.get('aiService').composite;
        aiService = (aiServiceSetting as AiService) || 'Use Pretzel AI Server';
        posthogPromptTelemetry = settings.get('posthogPromptTelemetry')
          .composite as boolean;

        const cookieSettings = await settingRegistry.load(
          '@jupyterlab/apputils-extension:notification'
        );
        const posthogCookieConsent = cookieSettings.get('posthogCookieConsent')
          .composite as string;

        initializePosthog(posthogCookieConsent === 'Yes');
        updateFunc?.();
        loadAIClient();
        showSplashScreen(posthogCookieConsent);
      } catch (reason) {
        console.error('Failed to load settings for Pretzel', reason);
      }
    }
    loadSettings();

    function loadAIClient() {
      if (aiService === 'OpenAI API key') {
        aiClient = new OpenAI({
          apiKey: openAiApiKey,
          dangerouslyAllowBrowser: true
        });
      } else if (aiService === 'Use Azure API') {
        aiClient = new OpenAIClient(
          azureBaseUrl,
          new AzureKeyCredential(azureApiKey)
        );
      } else {
        aiClient = null;
      }
    }
    loadAIClient(); // first time load, later settings will trigger this

    // Listen for future changes in settings
    settingRegistry.pluginChanged.connect((sender, plugin) => {
      if (plugin === extension.id) {
        const updateFunc = async () => {
          const submitButton = document.querySelector(
            '.pretzelInputSubmitButton'
          );
          const inputField = document.querySelector('.pretzelInputField');

          if (submitButton) {
            if (
              (aiService === 'OpenAI API key' && openAiApiKey) ||
              aiService === 'Use Pretzel AI Server' ||
              (aiService === 'Use Azure API' &&
                azureBaseUrl &&
                azureDeploymentName &&
                azureApiKey)
            ) {
              (submitButton as HTMLInputElement).disabled = false;
              (inputField as HTMLInputElement).placeholder = placeHolderEnabled;
            } else {
              (submitButton as HTMLInputElement).disabled = true;
              (inputField as HTMLInputElement).placeholder =
                placeholderDisabled;
            }
          }
        };
        loadSettings(updateFunc);
      }
    });

    notebookTracker.activeCellChanged.connect((sender, cell) => {
      if (cell && cell.model.type === 'code') {
        const codeCellModel = cell.model as CodeCellModel;
        codeCellModel.outputs.changed.connect(() => {
          const outputs = codeCellModel.outputs as OutputAreaModel;
          const errorOutput = findErrorOutput(outputs);
          if (errorOutput) {
            addFixErrorButton(
              cell.node.querySelector(
                '.jp-RenderedText.jp-mod-trusted.jp-OutputArea-output'
              ) as HTMLElement,
              codeCellModel
            );
          }
        });
        addAskAIButton(cell.node);
      }
    });

    function findErrorOutput(
      outputs: OutputAreaModel
    ): IOutputModel | undefined {
      for (let i = 0; i < outputs.length; i++) {
        const output = outputs.get(i);
        if (output.type === 'error') {
          return output;
        }
      }
      return undefined;
    }

    function addFixErrorButton(
      cellNode: HTMLElement,
      cellModel: CodeCellModel
    ) {
      // Remove existing button if any for case with multiple errors multiple buttons
      const existingButton = cellNode.querySelector('.fix-error-button');
      if (existingButton) {
        existingButton.remove();
      }

      const button = document.createElement('button');
      button.textContent = 'Fix Error with AI';
      button.className = 'fix-error-button';
      button.style.position = 'absolute';
      button.style.top = '10px';
      button.style.right = '10px';
      button.style.padding = '5px 10px';
      button.style.backgroundColor = '#007bff';
      button.style.color = 'white';
      button.style.border = 'none';
      button.style.borderRadius = '4px';
      button.style.cursor = 'pointer';
      cellNode.appendChild(button);
      button.onclick = () => {
        posthog.capture('Fix Error with AI', {
          event_type: 'click',
          method: 'fix_error'
        });
        const existingButton = cellNode.querySelector('.fix-error-button');
        if (existingButton) {
          existingButton.remove();
        }
        handleFixError(cellModel);
      };
    }

    function addAskAIButton(cellNode: HTMLElement) {
      // Hide button from non focused cells
      const existingButton = document.querySelector('.pretzel-ai-button');
      if (existingButton) {
        existingButton.remove();
      }

      const button = document.createElement('button');
      button.textContent = 'Ask AI';
      button.style.fontSize = '12px';
      button.className = 'pretzel-ai-button';
      button.style.position = 'absolute';
      button.style.top = '10px';
      button.style.right = '190px';
      button.style.padding = '2px 10px 3px 10px';
      button.style.backgroundColor = 'rgb(84 157 235)';
      button.style.color =
        document.body.getAttribute('data-jp-theme-light') === 'true'
          ? 'white'
          : 'rgba(0, 0, 0, 0.8)';
      button.style.border = 'none';
      button.style.borderRadius = '4px';
      button.style.cursor = 'pointer';
      button.style.zIndex = '1000';
      cellNode.appendChild(button);

      button.onclick = () => {
        posthog.capture('Ask AI', {
          event_type: 'click',
          method: 'ask_ai'
        });
        commands.execute('pretzelai:replace-code');
      };
    }

    async function handleFixError(cellModel: CodeCellModel) {
      const outputs = cellModel.outputs as OutputAreaModel;
      let traceback = findErrorOutput(outputs)!.toJSON().traceback;
      if (!traceback) {
        // handle error where traceback is undefined
        traceback = 'No traceback found';
      }
      // else  if traceback is an array, join with newlines
      else if (traceback instanceof Array) {
        // replace ANSI chars in traceback - they show colors that we don't need
        // eslint-disable-next-line no-control-regex
        traceback = traceback.join('\n').replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
      }
      // else traceback is some JS object. Convert it to a string representation
      else {
        traceback = traceback.toString();
      }
      const originalCode = cellModel.sharedModel.source;
      let activeCell = notebookTracker.activeCell!;
      const statusElement = document.createElement('p');
      statusElement.style.marginLeft = '70px';
      statusElement.textContent = 'Calculating embeddings...';
      activeCell.node.appendChild(statusElement);

      const topSimilarities = await getTopSimilarities(
        originalCode,
        embeddings,
        NUMBER_OF_SIMILAR_CELLS,
        aiClient,
        aiService,
        cellModel.id
      );
      const prompt = generatePrompt(
        '',
        originalCode,
        topSimilarities,
        '',
        traceback
      );
      let diffEditorContainer: HTMLElement = document.createElement('div');
      let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;

      const parentContainer = document.createElement('div');
      parentContainer.classList.add('pretzelParentContainerAI');
      activeCell.node.appendChild(parentContainer);

      diffEditor = renderEditor(
        '',
        parentContainer,
        diffEditorContainer,
        diffEditor,
        monaco,
        originalCode
      );

      openAiStream({
        aiService,
        openAiApiKey,
        openAiBaseUrl,
        prompt,
        parentContainer,
        inputContainer: null,
        diffEditorContainer,
        diffEditor,
        monaco,
        oldCode: originalCode,
        azureBaseUrl,
        azureApiKey,
        deploymentId: azureDeploymentName,
        activeCell,
        commands,
        statusElement
      })
        .then(() => {
          // clear output of the cell
          cellModel.outputs.clear();
        })
        .catch(error => {
          console.error('Error during OpenAI stream:', error);
        });
    }

    let embeddings: Embedding[];

    async function createEmbeddings(
      embeddingsJSON: Embedding[],
      cells: any[],
      path: string
    ) {
      embeddings = embeddingsJSON;
      const newEmbeddingsArray: Embedding[] = [];
      const promises = cells
        .filter(cell => cell.source.trim() !== '') // Filter out empty cells
        .map(cell => {
          return (async () => {
            const index = embeddings.findIndex(e => e.id === cell.id);
            if (index !== -1) {
              const hash = await calculateHash(cell.source);
              if (hash !== embeddings[index].hash) {
                try {
                  const response = await openaiEmbeddings(
                    cell.source,
                    aiService,
                    aiClient
                  );
                  newEmbeddingsArray.push({
                    id: cell.id,
                    source: cell.source,
                    hash,
                    embedding: response.data[0].embedding
                  });
                } catch (error) {
                  console.error('Error generating embedding:', error);
                }
              } else {
                newEmbeddingsArray.push(embeddings[index]);
              }
            } else {
              try {
                const response = await openaiEmbeddings(
                  cell.source,
                  aiService,
                  aiClient
                );
                const hash = await calculateHash(cell.source);
                newEmbeddingsArray.push({
                  id: cell.id,
                  source: cell.source,
                  hash,
                  embedding: response.data[0].embedding
                });
              } catch (error) {
                console.error('Error generating embedding:', error);
              }
            }
          })();
        });
      await Promise.allSettled(promises);
      const oldSet = new Set(embeddings.map(e => e.hash));
      const newSet = new Set(newEmbeddingsArray.map(e => e.hash));
      if (!isSetsEqual(oldSet, newSet)) {
        app.serviceManager.contents.save(path, {
          type: 'file',
          format: 'text',
          content: JSON.stringify(newEmbeddingsArray)
        });
      }
    }

    // Function to print the source of all cells once the notebook is defined
    function getEmbeddings() {
      const notebook = notebookTracker.currentWidget;
      if (notebook?.model) {
        const currentNotebookPath = notebook.context.path;
        const embeddingsPath =
          './.embeddings/' +
          currentNotebookPath.replace('.ipynb', '_embeddings.json');
        app.serviceManager.contents
          .get(embeddingsPath)
          .then(file => {
            try {
              const embJSON = JSON.parse(file.content);
              createEmbeddings(
                embJSON,
                notebook!.model!.sharedModel.cells,
                embeddingsPath
              );
            } catch (error) {
              console.error('Error parsing embeddings JSON:', error);
            }
          })
          .catch(async error => {
            app.serviceManager.contents.save(embeddingsPath, {
              type: 'file',
              format: 'text',
              content: JSON.stringify([])
            });
          });
        // Temporary solution to keep refreshing hashes in non blocking thread
        setTimeout(getEmbeddings, 1000);
      } else {
        setTimeout(getEmbeddings, 1000);
      }
    }
    getEmbeddings();

    async function getVariableValue(
      variableName: string
    ): Promise<string | null> {
      const notebook = notebookTracker.currentWidget;
      if (notebook && notebook.sessionContext.session?.kernel) {
        const kernel = notebook.sessionContext.session.kernel;
        try {
          // get the type - if dataframe, we get columns
          // if other, we get the string representation
          const executeRequest = kernel.requestExecute({
            code: `print(${variableName})`
          });
          let variableValue: string | null = null;

          // Registering a message hook to intercept messages
          kernel.registerMessageHook(
            executeRequest.msg.header.msg_id,
            (msg: IIOPubMessage) => {
              if (
                msg.header.msg_type === 'stream' &&
                // @ts-expect-error tserror
                msg.content.name === 'stdout'
              ) {
                // @ts-expect-error tserror
                variableValue = msg.content.text.trim();
              }
              return true;
            }
          );

          // Await the completion of the execute request
          const reply = await executeRequest.done;
          if (reply && reply.content.status === 'ok') {
            return variableValue;
          } else {
            console.error('Failed to retrieve variable value');
            return null;
          }
        } catch (error) {
          console.error('Error retrieving variable value:', error);
          return null;
        }
      } else {
        console.error('No active kernel found');
        return null;
      }
    }

    const getSelectedCode = () => {
      const selection = notebookTracker.activeCell?.editor?.getSelection();
      const cellCode = notebookTracker.activeCell?.model.sharedModel.source;
      let extractedCode = '';
      if (
        selection &&
        (selection.start.line !== selection.end.line ||
          selection.start.column !== selection.end.column)
      ) {
        const startLine = selection.start.line;
        const endLine = selection.end.line;
        const startColumn = selection.start.column;
        const endColumn = selection.end.column;
        for (let i = startLine; i <= endLine; i++) {
          const lineContent = cellCode!.split('\n')[i];
          if (lineContent !== undefined) {
            if (i === startLine && i === endLine) {
              extractedCode += lineContent.substring(startColumn, endColumn);
            } else if (i === startLine) {
              extractedCode += lineContent.substring(startColumn);
            } else if (i === endLine) {
              extractedCode += '\n' + lineContent.substring(0, endColumn);
            } else {
              extractedCode += '\n' + lineContent;
            }
          }
        }
      }
      // also return the selection
      return { extractedCode: extractedCode.trimEnd(), selection };
    };

    async function processTaggedVariables(userInput: string): Promise<string> {
      const variablePattern = /@(\w+)/g;
      let match;
      let modifiedUserInput = userInput;
      // find all code that starts with `import` in the notebook
      const imports =
        notebookTracker.currentWidget!.model!.sharedModel.cells.filter(cell =>
          cell.source.split('\n').some(line => line.includes('import'))
        );
      const importsCode = imports
        .map(cell =>
          cell.source
            .split('\n')
            .filter(line => line.trim().includes('import'))
            .join('\n')
        )
        .join('\n');

      modifiedUserInput += `The following imports are already present in the notebook:\n${importsCode}\n`;

      // call getVariableValue to get the list of globals() from python
      const getVarsCode = `[var for var in globals() if not var.startswith('_') and not callable(globals()[var]) and var not in ['In', 'Out']]`;
      const listVars = await getVariableValue(getVarsCode);

      modifiedUserInput += `The following variables exist in memory of the notebook kernel:\n${listVars}\n`;

      while ((match = variablePattern.exec(userInput)) !== null) {
        try {
          const variableName = match[1];
          // get value of var using the getVariableValue function
          const variableType = await getVariableValue(`type(${variableName})`);

          // check if variableType is dataframe
          // if it is, get columns and add to modifiedUserInput
          if (variableType?.includes('DataFrame')) {
            const variableColumns = await getVariableValue(
              `${variableName}.columns`
            );
            modifiedUserInput += `\n${variableName} is a dataframe with the following columns: ${variableColumns}\n`;
          } else if (variableType) {
            const variableValue = await getVariableValue(variableName);
            modifiedUserInput += `\nPrinting ${variableName} in Python returns the string ${variableValue}\n`;
          }
        } catch (error) {
          console.error(`Error accessing variable ${match[1]}:`, error);
        }
      }
      return modifiedUserInput;
    }

    commands.addCommand(command, {
      label: 'Replace Cell Code',
      execute: () => {
        const activeCell = notebookTracker.activeCell;

        let diffEditorContainer: HTMLElement = document.createElement('div');
        let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;

        if (activeCell) {
          // Cmd K twice should toggle the box
          const existingDiv = activeCell.node.querySelector(
            '.pretzelParentContainerAI'
          );
          // this code is repeated with the removeHandler
          if (existingDiv) {
            // If so, delete that div
            existingDiv.remove();
            // Switch focus back to the Jupyter cell
            posthog.capture('Remove via Cmd K', {
              event_type: 'keypress',
              event_value: 'Cmd+k',
              method: 'remove'
            });
            const statusElements = activeCell.node.querySelectorAll(
              'p[style="margin-left: 70px;"]'
            );
            statusElements.forEach(element => element.remove());

            // Switch focus back to the Jupyter cell
            activeCell!.editor!.focus();
            return;
          }

          const oldCode = activeCell.model.sharedModel.source;

          const statusElement = document.createElement('p');
          statusElement.textContent = '';
          statusElement.style.marginLeft = '70px';
          activeCell.node.appendChild(statusElement);

          // Create a parent container for all dynamically created elements
          const parentContainer = document.createElement('div');
          parentContainer.classList.add('pretzelParentContainerAI');
          activeCell.node.appendChild(parentContainer);
          // Create an input field and append it below the cell
          const inputContainer = document.createElement('div');
          inputContainer.style.marginTop = '10px';
          inputContainer.style.marginLeft = '70px';
          inputContainer.style.display = 'flex';
          inputContainer.style.flexDirection = 'column';
          parentContainer.appendChild(inputContainer);

          const inputField = document.createElement('textarea');
          inputField.classList.add('pretzelInputField');
          inputField.placeholder = placeHolderEnabled;
          inputField.style.width = '100%';
          inputField.style.height = '100px';
          inputContainer.appendChild(inputField);
          inputField.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
              // TODO: this doesn't work - the Escape key isn't being captured
              // but every other key press is being captured
              posthog.capture('Remove via Escape', {
                event_type: 'keypress',
                event_value: 'esc',
                method: 'remove'
              });
              event.preventDefault(); // Prevent any default behavior
              // Shift focus back to the editor of the active cell
              const activeCell = notebookTracker.activeCell;
              if (activeCell && activeCell.editor) {
                activeCell.editor.focus(); // Focus the editor of the active cell
              }
            }
            // handle enter key press to trigger submit
            if (event.key === 'Enter') {
              event.preventDefault();
              if (!submitButton.disabled) {
                posthog.capture('Submit via Enter', {
                  event_type: 'keypress',
                  event_value: 'enter',
                  method: 'submit'
                });
                handleSubmit(inputField.value);
              }
            }
          });

          const inputFieldButtonsContainer = document.createElement('div');
          inputFieldButtonsContainer.style.marginTop = '10px';
          inputFieldButtonsContainer.style.display = 'flex';
          inputFieldButtonsContainer.style.flexDirection = 'row';
          inputContainer.appendChild(inputFieldButtonsContainer);
          inputField.focus();

          const submitButton = document.createElement('button');
          submitButton.classList.add('pretzelInputSubmitButton');
          submitButton.textContent = 'Submit';
          submitButton.style.backgroundColor = 'lightblue';
          submitButton.style.borderRadius = '5px';
          submitButton.style.border = '1px solid darkblue';
          submitButton.style.maxWidth = '100px';
          submitButton.style.minHeight = '25px';
          submitButton.style.marginTop = '10px';
          submitButton.style.marginRight = '10px';
          submitButton.addEventListener('click', () => {
            posthog.capture('Submit via Click', {
              event_type: 'click',
              method: 'submit'
            });
            handleSubmit(inputField.value);
          });
          inputFieldButtonsContainer.appendChild(submitButton);

          // write code to add a button the removed the inputField and submitButton
          const removeButton = document.createElement('button');
          removeButton.textContent = 'Remove';
          removeButton.style.backgroundColor = 'lightcoral';
          removeButton.style.borderRadius = '5px';
          removeButton.style.border = '1px solid darkred';
          removeButton.style.maxWidth = '100px';
          removeButton.style.minHeight = '25px';
          removeButton.style.marginTop = '10px';
          inputFieldButtonsContainer.appendChild(removeButton);
          const removeHandler = () => {
            posthog.capture('Remove via Click', {
              event_type: 'click',
              method: 'remove'
            });
            activeCell.node.removeChild(parentContainer);
            const statusElements = activeCell.node.querySelectorAll(
              'p[style="margin-left: 70px;"]'
            );
            statusElements.forEach(element => element.remove());

            // Switch focus back to the Jupyter cell
            activeCell!.editor!.focus();
          };

          removeButton.addEventListener('click', removeHandler);

          const handleSubmit = async (userInput: string) => {
            parentContainer.removeChild(inputContainer);
            const { extractedCode } = getSelectedCode();
            statusElement.textContent = 'Calculating embeddings...';
            if (userInput !== '') {
              userInput = await processTaggedVariables(userInput);
              try {
                const topSimilarities = await getTopSimilarities(
                  userInput,
                  embeddings,
                  NUMBER_OF_SIMILAR_CELLS,
                  aiClient,
                  aiService,
                  activeCell.model.id
                );
                const prompt = generatePrompt(
                  userInput,
                  oldCode,
                  topSimilarities,
                  extractedCode
                );

                // if posthogPromptTelemetry is true, capture the prompt
                if (posthogPromptTelemetry) {
                  posthog.capture('prompt', { property: userInput });
                } else {
                  posthog.capture('prompt', { property: 'no_telemetry' });
                }
                diffEditor = renderEditor(
                  '',
                  parentContainer,
                  diffEditorContainer,
                  diffEditor,
                  monaco,
                  oldCode
                );
                openAiStream({
                  aiService,
                  parentContainer,
                  diffEditorContainer,
                  diffEditor,
                  monaco,
                  oldCode,
                  inputContainer,
                  // OpenAI API
                  openAiApiKey,
                  openAiBaseUrl,
                  prompt,
                  // Azure API
                  azureApiKey,
                  azureBaseUrl,
                  deploymentId: azureDeploymentName,
                  activeCell,
                  commands,
                  statusElement
                });
              } catch (error) {
                activeCell.node.removeChild(parentContainer);
              }
            }
          };
        }
      }
    });

    const category = 'Cell Operations';
    palette.addItem({ command, category });

    app.commands.addKeyBinding({
      command,
      keys: ['Accel K'],
      selector: '.jp-Notebook'
    });
  }
};

export default extension;