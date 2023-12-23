const sonarQubeScanner = require('sonarqube-scanner');

sonarQubeScanner(
    {
        serverUrl: 'http://localhost:9000',
        token: 'sqp_7227a62088241919c283534dc0164cfdaeb9ce60',
        options: {
            'sonar.projectName': 'facebook',
            'sonar.source': 'packages/*',
            'sonar.inclusions': 'packages/**'
        }
    },
    () => { }
)