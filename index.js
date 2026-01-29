const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));

// Path al service account JSON
const SERVICE_ACCOUNT_FILE = './credentials/noleggio-auto-backend-204c228562eb.json';

// Scope Gmail + Drive + Docs
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/gmail.send'
];

// Service account auth
const auth = new google.auth.GoogleAuth({
  keyFile: SERVICE_ACCOUNT_FILE,
  scopes: SCOPES
});

// Mappa dei template documenti
const templates = {
  'preventivo': {
    'Privato': '156Ufe6qWMZZLh1rbsUAGXIxCvtlpCHRLmvxHfl9MDfc',
    'Azienda': '1DVCFbfEqOwfZT05yZ8_X-CL5122xGK1W5A8_DX3PEmQ'
  },
  'contratto': {
    'Privato': '1PueKnt-WthhYq7b702l_zlU8yoSEQK1_6h7EQxBvshc',
    'Azienda': '1koJ4v3hcysD-4pWboW9SBQps4MRQNaA_FwS-taZ9Yfw'
  }
};

// Email principale
const tuaEmail = 'noleggioautotrento@gmail.com';

// ====== ENDPOINT GET ======
app.get('/', (req, res) => {
  res.json({ success: false, message: "Questo endpoint supporta solo richieste POST" });
});

// ====== ENDPOINT POST ======
app.post('/', async (req, res) => {
  try {
    const data = req.body;
    if (!data) throw new Error('Nessun dato ricevuto');

    const tipoCliente = data['cliente-tipo'] || 'Privato';

    const templateIdPreventivo = templates['preventivo'][tipoCliente];
    const templateIdContratto = templates['contratto'][tipoCliente];

    if (!templateIdPreventivo) throw new Error('Template preventivo non trovato');
    if (!templateIdContratto) throw new Error('Template contratto non trovato');

    // Genera PDF
    const pdfPreventivo = await generatePDF(data, templateIdPreventivo);
    const pdfContratto = await generatePDF(data, templateIdContratto);

    // Email cliente
    const emailCliente = data.email || 'destinatario@default.com';
    const subjectCliente = 'Il tuo preventivo';
    const bodyCliente = prepareEmailBody(data);
    await sendEmail(emailCliente, subjectCliente, bodyCliente, pdfPreventivo, 'preventivo');

    // Email interna
    const subjectInterna = 'Preventivo e Contratto - ' + (data['nome-cognome'] || data['denominazione'] || 'Cliente');
    const bodyInterna = prepareInternalEmailBody(data, emailCliente);
    await sendEmail(emailCliente=tuaEmail, subjectInterna, bodyInterna, [pdfPreventivo, pdfContratto], ['preventivo','contratto']);

    res.json({
      success: true,
      message: 'Preventivo e contratto generati e inviati con successo',
      emailInviataA: emailCliente,
      copiaInviataA: tuaEmail,
      clienteTipo: tipoCliente,
      documentiGenerati: ['preventivo', 'contratto']
    });

  } catch (error) {
    console.error(error);
    res.json({ success: false, error: error.toString() });
  }
});

// ====== FUNZIONI DI SUPPORTO ======

// Genera PDF dal template Google Docs
async function generatePDF(data, templateId) {
  const drive = google.drive({ version: 'v3', auth });
  const docs = google.docs({ version: 'v1', auth });

  // Copia documento
  const copy = await drive.files.copy({
    fileId: templateId,
    requestBody: { name: `Copy_${Date.now()}` }
  });

  const docId = copy.data.id;

  // Sostituzioni nel documento
  let requests = [];
  for (const key in data) {
    requests.push({
      replaceAllText: {
        containsText: { text: `{{${key}}}`, matchCase: true },
        replaceText: data[key] || ''
      }
    });
  }

  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });

  // Esporta in PDF
  const pdfBuffer = await drive.files.export(
    { fileId: docId, mimeType: 'application/pdf' },
    { responseType: 'arraybuffer' }
  );

  // Cancella copia
  await drive.files.delete({ fileId: docId });

  return Buffer.from(pdfBuffer.data);
}

// Invia email con PDF
async function sendEmail(to, subject, htmlBody, pdfs, tipi=['']) {
  const gmail = google.gmail({ version: 'v1', auth });

  if (!Array.isArray(pdfs)) pdfs = [pdfs];

  let attachments = pdfs.map((pdf, i) => ({
    filename: `${tipi[i] || 'documento'}_${Date.now()}.pdf`,
    content: pdf.toString('base64'),
    encoding: 'base64'
  }));

  let messageParts = [
    `From: ${tuaEmail}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="boundary123"',
    '',
    '--boundary123',
    'Content-Type: text/html; charset=UTF-8',
    '',
    htmlBody
  ];

  attachments.forEach(att => {
    messageParts.push('--boundary123');
    messageParts.push('Content-Type: application/pdf; name="' + att.filename + '"');
    messageParts.push('Content-Transfer-Encoding: base64');
    messageParts.push('Content-Disposition: attachment; filename="' + att.filename + '"');
    messageParts.push(att.content);
  });

  messageParts.push('--boundary123--');

  const raw = Buffer.from(messageParts.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// Corpo email cliente
function prepareEmailBody(data) {
  const nomeCliente = data['nome-cognome'] || data['denominazione'] || 'Cliente';
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Gentile ${nomeCliente},</h2>
      <p>Grazie per aver richiesto un preventivo. In allegato trovi il documento dettagliato.</p>
      <p><strong>Veicolo:</strong> ${data['veicolo-display'] || ''}</p>
      <p><strong>Importo:</strong> €${data['preventivo'] || ''}</p>
      <p><strong>Data ritiro:</strong> ${data['ritiro-data-display'] || ''}</p>
      <p><strong>Data consegna:</strong> ${data['consegna-data-display'] || ''}</p>
      <p>Cordiali saluti,<br>Il Team</p>
    </div>
  `;
}

// Corpo email interna
function prepareInternalEmailBody(data, emailCliente) {
  const nomeCliente = data['nome-cognome'] || data['denominazione'] || 'Cliente';
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Preventivo e Contratto Generati</h2>
      <p><strong>Nome:</strong> ${nomeCliente}</p>
      <p><strong>Email cliente:</strong> ${emailCliente}</p>
      <p><strong>Cellulare:</strong> ${data['cellulare'] || 'Non fornito'}</p>
      <p><strong>Veicolo:</strong> ${data['veicolo-display'] || ''}</p>
      <p><strong>Importo:</strong> €${data['preventivo'] || ''}</p>
      <p><strong>Data ritiro:</strong> ${data['ritiro-data-display'] || ''}</p>
      <p><strong>Data consegna:</strong> ${data['consegna-data-display'] || ''}</p>
      <p><strong>Numero preventivo:</strong> ${data['numero-preventivo'] || ''}</p>
      <p><strong>Tipo cliente:</strong> ${data['cliente-tipo'] || ''}</p>
      <p><em>In allegato trovi sia il preventivo inviato al cliente che il contratto pronto.</em></p>
    </div>
  `;
}

// ====== START SERVER ======
app.listen(PORT, () => console.log(`Server in ascolto sulla porta ${PORT}`));
