import fs from 'node:fs';
import {createHash} from 'node:crypto';
const {version}=JSON.parse(fs.readFileSync('package.json','utf8'));
const files=fs.readdirSync('release').filter(name=>name.startsWith('CLI-Desk-'+version+'-')&&/\.(exe|dmg)$/.test(name));
if(!files.length)throw new Error('No installer found.');
fs.writeFileSync('release/SHA256SUMS.txt',files.map(name=>createHash('sha256').update(fs.readFileSync('release/'+name)).digest('hex')+'  '+name).join('\n')+'\n');
