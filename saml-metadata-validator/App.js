import React, {useState, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {SamlValidator} from './validator.js';
// CodeMirror 6: use static ESM imports so Vite dedupes a single instance
import { EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { xml } from '@codemirror/lang-xml';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';

// CSS removed: using plain HTML without styles for now

function App() {
	const [xmlInput, setXmlInput] = useState('');
	const [results, setResults] = useState([]);
	const [isValidating, setIsValidating] = useState(false);
	const [validator, setValidator] = useState(null);
	const [isLoaded, setIsLoaded] = useState(false);
	// Config is static and loaded from ./config/checks.json; no GUI controls
	const [configJson, setConfigJson] = useState('[]');

	useEffect(() => {
		const v = new SamlValidator();
		v.initialize()
			.then(() => {
				setValidator(v);
				setIsLoaded(true);
			})
			.catch((err) => {
				setResults([{type: 'error', message: 'Failed to initialize validator: ' + err.message}]);
			});
	}, []);

	useEffect(() => {
		// Load checks configuration from external JSON file served locally
		const loadConfig = async () => {
			try {
				const res = await fetch('./config/checks.json', {cache: 'no-cache'});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = await res.json();
				setConfigJson(JSON.stringify(json, null, 2));
			} catch (e) {
				// Fall back to empty array and inform user in results panel (non-blocking)
				setConfigJson('[]');
				setResults(prev => ([
					...prev,
					{type: 'error', message: 'Could not load checks config (./config/checks.json): ' + e.message}
				]));
			}
		};
		loadConfig();
	}, []);

	const validateXml = async () => {
		if (!validator || !xmlInput.trim()) return;
		setIsValidating(true);

		try {
			const parsedConfig = JSON.parse(configJson);
			validator.setConfig(parsedConfig);
		} catch (e) {
			setResults([{type: 'error', message: 'Invalid Configuration JSON: ' + e.message}]);
			setIsValidating(false);
			return;
		}

		const newResults = await validator.validate(xmlInput);
		setResults(newResults);
		setIsValidating(false);
	};

	const handleFileUpload = (event) => {
		const file = event.target.files[0];
		if (!file) return;
		const reader = new window.FileReader();
		reader.onload = (e) => {
			const result = e.target.result;
			if (typeof result === 'string') {
				setXmlInput(result);
			}
		};
		reader.readAsText(file);
	};

 const syncUI = async () => {
        const rootNode = document.getElementById('validator-root');
        if (!rootNode) return;
        const template = document.getElementById('validator-template');
        if (!template) return;

        // Initialize UI once: only clone the template if the root is empty
        if (!rootNode.hasChildNodes()) {
            const clone = template.content.cloneNode(true);
            rootNode.appendChild(clone);
        }

        // Bind essential elements from the template
        const xmlEditorContainer = rootNode.querySelector('#xml-editor');
        const editorError = rootNode.querySelector('#editor-error');
        const fileInput = rootNode.querySelector('#file-upload');
        const validateBtn = rootNode.querySelector('#validate-btn');
        const resultsContainer = rootNode.querySelector('#results-container');

        // Mark app as booted once we've initialized the template
        try { window.__appBootOk = true; } catch (_) {}

        // Initialize CodeMirror editor once (preferred) and keep it in sync
        // If CodeMirror cannot be loaded, show a simple error message
        let editorView = rootNode.__xmlEditor || null;
        if (!editorView && xmlEditorContainer) {
            try {
                // Stable extension set: XML language, basic visuals, history, and keymaps
                const extensions = [
                    xml(),
                    lineNumbers(),
                    drawSelection(),
                    highlightActiveLine(),
                    history(),
                    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
                    syntaxHighlighting(defaultHighlightStyle),
                    // Update listener to sync React state
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged) {
                            const val = update.state.doc.toString();
                            setXmlInput(prev => (prev === val ? prev : val));
                        }
                    }),
                ];

                const startState = EditorState.create({
                    doc: xmlInput,
                    extensions,
                });
                editorView = new EditorView({ state: startState, parent: xmlEditorContainer });
                rootNode.__xmlEditor = editorView;
                if (editorError) editorError.style.display = 'none';
            } catch (_) {
                if (editorError) {
                    editorError.textContent = 'Could not load editor (init failed).';
                    editorError.style.display = 'block';
                }
                if (import.meta && import.meta.env && import.meta.env.DEV) throw _;
                return;
            }
        }

        if (editorView) {
            // Keep editor content in sync with state (e.g., after file upload)
            const current = editorView.state.doc.toString();
            if (current !== xmlInput) {
                const sel = editorView.state.selection; // preserve selection
                editorView.dispatch({
                    changes: { from: 0, to: editorView.state.doc.length, insert: xmlInput },
                    selection: sel,
                });
            }
        }

        if (validateBtn) {
            validateBtn.disabled = isValidating || !isLoaded;
            validateBtn.textContent = isValidating ? 'Validating...' : 'Validate Now';
        }

        // Render Results (replace content but do not touch outer structure)
        if (resultsContainer) {
            // Always clear and re-render results only
            resultsContainer.innerHTML = '';
            if (results.length > 0) {
                results.forEach(res => {
                    const resDiv = document.createElement('div');
                    const msgDiv = document.createElement('div');
                    msgDiv.textContent = `${res.type.toUpperCase()}: ${res.message}`;
                    resDiv.appendChild(msgDiv);

                    if (res.help) {
                        const helpDiv = document.createElement('div');
                        helpDiv.textContent = res.help;
                        resDiv.appendChild(helpDiv);
                    }
                    resultsContainer.appendChild(resDiv);
                });
            } else {
                const placeholder = document.createElement('div');
                placeholder.textContent = 'Results will appear here...';
                resultsContainer.appendChild(placeholder);
            }
        }

        // UI to State (Event Listeners) — assigning properties is idempotent
        if (fileInput) fileInput.onchange = handleFileUpload;
        if (validateBtn) validateBtn.onclick = validateXml;
    };

 useEffect(() => {
        // Re-sync UI only when relevant state changes
        syncUI();
    }, [xmlInput, results, isValidating, isLoaded]);

	// We render nothing; the UI is managed by manipulating the existing
	// #validator-root element provided in index.html via syncUI().
	return null;
}

const rootContainer = document.getElementById('root');
if (rootContainer) {
	const root = createRoot(rootContainer);
	const appElement = React.createElement(App);
	root.render(appElement);
}
