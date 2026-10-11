const fs = require('fs');
const path = require('path');

const source = require.resolve('flowbite/dist/flowbite.min.js');
const outputDirectory = path.join(__dirname, '..', 'public', 'assets');
fs.mkdirSync(outputDirectory, { recursive: true });
fs.copyFileSync(source, path.join(outputDirectory, 'flowbite.min.js'));
