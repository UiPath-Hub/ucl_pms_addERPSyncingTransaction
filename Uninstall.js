const Service = require('node-windows').Service;
const path = require('path');
const packageJson = require('./package.json');

const uninstall = async () => {
  console.log(`Uninstalling...\nPackage name: ${packageJson.name}`);

  const svc = new Service({
    name: packageJson.name,
    script: path.join(__dirname, 'dist', packageJson.main)
  });

  svc.on('uninstall', () => {
    console.log('Service uninstalled successfully!');
  });

  svc.on('alreadyuninstalled', () => {
    console.log('Service is not installed or already removed.');
  });

  svc.uninstall();
};

uninstall();
