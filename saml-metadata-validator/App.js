import React, {useState, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {SamlValidator} from './validator.js';

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

	const syncUI = () => {
		const rootNode = document.getElementById('validator-root');
		if (!rootNode) return;
		const template = document.getElementById('validator-template');
		if (!template) return;

		// Clear existing and clone template
		rootNode.innerHTML = '';
		const clone = template.content.cloneNode(true);
		rootNode.appendChild(clone);

		// Bind essential elements from the template (config GUI removed)
		const xmlTextarea = rootNode.querySelector('#xml-input');
		const fileInput = rootNode.querySelector('#file-upload');
		const validateBtn = rootNode.querySelector('#validate-btn');
		const resultsContainer = rootNode.querySelector('#results-container');

		// Sync State to UI
		if (xmlTextarea) xmlTextarea.value = xmlInput;
		if (validateBtn) {
			validateBtn.disabled = isValidating || !isLoaded;
			validateBtn.textContent = isValidating ? 'Validating...' : 'Validate Now';
		}

		// Render Results
		if (resultsContainer) {
			if (results.length > 0) {
				resultsContainer.innerHTML = '';
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
			}
		}

		// UI to State (Event Listeners)
		if (xmlTextarea) {
			xmlTextarea.onchange = (e) => setXmlInput(e.target.value);
			xmlTextarea.oninput = (e) => setXmlInput(e.target.value);
		}
		if (fileInput) fileInput.onchange = handleFileUpload;
		if (validateBtn) validateBtn.onclick = validateXml;
	};

	useEffect(() => {
		syncUI();
	});

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
