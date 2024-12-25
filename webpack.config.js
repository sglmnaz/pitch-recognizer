const path = require('path');

module.exports = {
    entry: './js/index.js', // Your main JavaScript file
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, 'dist')
    },
    mode: 'development' // Or 'production' for optimized builds
};