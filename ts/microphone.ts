import * as Pitchy from 'pitchy'

let audioContext
let analyser
let scriptProcessor
let bufferLength
let dataArray

let readings: any[] = []
let maxFrequencies: any[] = []

function start(callback, errCallback) {
	audioContext = new window.AudioContext()
	analyser = audioContext.createAnalyser()
	analyser.fftSize = 2048
	bufferLength = analyser.frequencyBinCount
	dataArray = new Float32Array(bufferLength) // Use Float32Array for Pitchy

	navigator.mediaDevices
		.getUserMedia({ audio: true })
		.then((stream) => {
			const source = audioContext.createMediaStreamSource(stream)
			source.connect(analyser)

			scriptProcessor = audioContext.createScriptProcessor(2048, 1, 1)
			analyser.connect(scriptProcessor)
			scriptProcessor.connect(audioContext.destination)

			scriptProcessor.onaudioprocess = function () {
				analyser.getFloatTimeDomainData(dataArray) // Get Float32 data

				// Calculate RMS (Root Mean Square) for loudness
				let sumSquares = 0
				for (let i = 0; i < dataArray.length; i++) {
					sumSquares += dataArray[i] * dataArray[i]
				}
				let loudness = Math.sqrt(sumSquares / dataArray.length)

				if (loudness < 0.03) {
					return
				}

				const pitchDetector = Pitchy.PitchDetector.forFloat32Array(dataArray.length)
				let pitch = pitchDetector.findPitch(dataArray, audioContext.sampleRate)[0]

				//keeps the last 10 readings in an array
				readings.push({ pitch: pitch, volume: loudness })
				if (readings.length > 10) {
					readings.shift()
				}

				//takes the loudest of the last 10 readings
				const maxVolumeElement = readings.reduce((prev, current) => {
					return prev.volume > current.volume ? prev : current
				})

				if (maxVolumeElement) {
					//keeps the last 10 highest readings
					maxFrequencies.push(maxVolumeElement.pitch)
					if (maxFrequencies.length > 10) {
						maxFrequencies.shift()
					}

					//remove readings that are too off from the others
					let maxFrequenciesWithoutOutliers = removeOutliers(maxFrequencies)

					if (maxFrequenciesWithoutOutliers.length > 0) {
						let frequency = maxFrequenciesWithoutOutliers.pop()

						if (frequency) {
							callback(frequency)
							return
						}
					}
				}

				callback('--')
			}
		})
		.catch((err) => {
			console.error('Error accessing microphone:', err)
			errCallback()
		})
}

function stop() {
	if (audioContext) {
		audioContext.close()
	}
}

function removeOutliers(arr) {
	// Sort the array
	const sortedArr = [...arr].sort((a, b) => a - b)

	// Calculate the Interquartile Range (IQR)
	const q1 = sortedArr[Math.floor(sortedArr.length * 0.25)]
	const q3 = sortedArr[Math.ceil(sortedArr.length * 0.75)]
	const iqr = q3 - q1

	// Define lower and upper bounds for outliers
	const lowerBound = q1 - 1.5 * iqr
	const upperBound = q3 + 1.5 * iqr

	// Remove outliers from the array
	return arr.filter((num) => num >= lowerBound && num <= upperBound)
}

export { start, stop }
