import React, {useState, useEffect, useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import SamlValidator from './validator.js';
// CodeMirror 6: use static ESM imports so Vite dedupes a single instance
import {EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap} from '@codemirror/view';
import {EditorState} from '@codemirror/state';
import {xml} from '@codemirror/lang-xml';
import {history, historyKeymap, defaultKeymap, indentWithTab} from '@codemirror/commands';
import {syntaxHighlighting, defaultHighlightStyle} from '@codemirror/language';

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
				if (!res.ok) { // noinspection ExceptionCaughtLocallyJS
					throw new Error(`HTTP ${res.status}`);
				}
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
		// Explicitly discard the promise to satisfy IDE inspections
		void loadConfig();
	}, []);

	const validateXml = useCallback(async () => {
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
	}, [validator, xmlInput, configJson]);

	const handleFileUpload = useCallback((event) => {
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
	}, []);

	// --- UI Setup helpers
	const initTemplate = useCallback(() => {
		const rootNode = document.getElementById('validator-root');
		const template = document.getElementById('validator-template');
		if (!rootNode || !template) return;
		if (!rootNode.hasChildNodes()) {
			const clone = template.content.cloneNode(true);
			rootNode.appendChild(clone);
		}
		if (typeof window !== 'undefined') {
			window.__appBootOk = true;
		}
	}, []);

	const initEditor = useCallback(() => {
		const rootNode = document.getElementById('validator-root');
		if (!rootNode) return;
		const xmlEditorContainer = rootNode.querySelector('#xml-editor');
		const editorError = rootNode.querySelector('#editor-error');
		let editorView = rootNode.__xmlEditor || null;
		if (editorView || !xmlEditorContainer) return; // already initialized or missing container
		try {
			const extensions = [
				xml(),
				lineNumbers(),
				drawSelection(),
				highlightActiveLine(),
				history(),
				keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
				syntaxHighlighting(defaultHighlightStyle),
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
			editorView = new EditorView({state: startState, parent: xmlEditorContainer});
			rootNode.__xmlEditor = editorView;
			if (editorError) editorError.style.display = 'none';
		} catch (err) {
			if (editorError) {
				editorError.textContent = 'Could not load editor (init failed).';
				editorError.style.display = 'block';
			}
			if (import.meta && import.meta.env && import.meta.env.DEV) throw err;
		}
	}, [xmlInput]);

	const syncEditorContent = useCallback(() => {
		const rootNode = document.getElementById('validator-root');
		if (!rootNode) return;
		const editorView = rootNode.__xmlEditor;
		if (!editorView) return;
		const current = editorView.state.doc.toString();
		if (current !== xmlInput) {
			const sel = editorView.state.selection;
			editorView.dispatch({
				changes: {from: 0, to: editorView.state.doc.length, insert: xmlInput},
				selection: sel,
			});
		}
	}, [xmlInput]);

	const updateValidateButton = useCallback(() => {
		const rootNode = document.getElementById('validator-root');
		if (!rootNode) return;
		const validateBtn = rootNode.querySelector('#validate-btn');
		if (!validateBtn) return;
		validateBtn.disabled = isValidating || !isLoaded;
		validateBtn.textContent = isValidating ? 'Validating...' : 'Validate Now';
	}, [isValidating, isLoaded]);

	const renderResults = useCallback(() => {
		const rootNode = document.getElementById('validator-root');
		if (!rootNode) {
			console.log("renderResults(): #validator-root not found");
			return;
		}
		const resultsContainer = rootNode.querySelector('#results-container');
		if (!resultsContainer) {
			console.log("renderResults(): #results-container not found");
			return;
		}
		resultsContainer.innerHTML = '';
		if (results.length > 0) {
			results.forEach(res => {
				const resDiv = document.createElement('div');
				const typeDiv = document.createElement('div');
				const lineDiv = document.createElement('div');
				const msgDiv = document.createElement('div');
				const helpDiv = document.createElement('div');

				resDiv.className = 'results-entry';
				typeDiv.className = 'results-type';
				lineDiv.className = 'results-lineno';
				msgDiv.className = 'results-msg';
				helpDiv.className = 'results-help';

				switch (res.type) {
					case "error":
						resDiv.classList.add("result-error");
						break;
					case "warning":
						resDiv.classList.add("result-warning");
						break;
					case "success":
						resDiv.classList.add("result-success");
						break;
					case "info":
						resDiv.classList.add("result-info");
						break;
				}

				typeDiv.textContent = res.type;
				msgDiv.textContent = res.message;
				if (res.line) {
					lineDiv.textContent = res.line;
				}
				if (res.help) {
					helpDiv.textContent = res.help;
				}
				resDiv.append(typeDiv, lineDiv, msgDiv, helpDiv);
				resultsContainer.appendChild(resDiv);
			});
		} else {
			const placeholder = document.createElement('div');
			placeholder.className = 'results-placeholder';
			placeholder.textContent = 'Results will appear here...';
			resultsContainer.appendChild(placeholder);
		}
	}, [results]);

	const bindEventHandlers = useCallback(() => {
		const rootNode = document.getElementById('validator-root');
		if (!rootNode) return;
		const fileInput = rootNode.querySelector('#file-upload');
		const validateBtn = rootNode.querySelector('#validate-btn');
		if (fileInput) fileInput.onchange = handleFileUpload;
		if (validateBtn) validateBtn.onclick = validateXml;
	}, [handleFileUpload, validateXml]);

	// --- Effects wiring each responsibility with correct deps
	useEffect(() => {
		initTemplate();
	}, [initTemplate]);
	useEffect(() => {
		initEditor();
	}, [initEditor]);
	useEffect(() => {
		syncEditorContent();
	}, [syncEditorContent]);
	useEffect(() => {
		updateValidateButton();
	}, [updateValidateButton]);
	useEffect(() => {
		renderResults();
	}, [renderResults]);
	useEffect(() => {
		bindEventHandlers();
	}, [bindEventHandlers]);

	// We render nothing; the UI is managed by manipulating the existing
	// #validator-root element provided in index.html via syncUI().
	return null;
}

const rootContainer = document.getElementById('root');
if (rootContainer) {
	const root = createRoot(rootContainer);
	/** @type {import('react').ReactNode} */
	const appElement = React.createElement(App);
	root.render(appElement);
}
