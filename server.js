require('dotenv').config(); // Load environment variables from .env file

const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const { TelegramClient,  Api } = require('telegram');
const fs = require('fs');
const path = require('path');

const app = express();

// Middleware
app.use(bodyParser.json());
app.use(
    cors({
        origin: 'http://localhost:3000',
        credentials: true,
    })
);
app.use(cookieParser());

const configPath = path.join(__dirname, 'config.json');

// Helper function to read config
const readConfig = () => {
  const configData = fs.readFileSync(configPath);
  return JSON.parse(configData);
};

// Helper function to write config
const writeConfig = (config) => {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
};

// Environment Variables
const REGISTRATION_SPREADSHEET_ID = process.env.REGISTRATION_SPREADSHEET_ID;
const LOGIN_SPREADSHEET_ID = process.env.LOGIN_SPREADSHEET_ID;
const SECRET_KEY = process.env.SECRET_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const TELEGRAM_API_ID = process.env.TELEGRAM_API_ID;
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const TELEGRAM_SESSION_STRING = process.env.TELEGRAM_SESSION_STRING;
const CREDENTIALS = require('./credentials.json'); // Path to your credentials.json file



const auth = new google.auth.GoogleAuth({
    credentials: CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});


const verifyToken = (req, res, next) => {
    const token = req.cookies.token;
    // console.log('Cookies received:', req.cookies); // Log all cookies
    // console.log('Token received in middleware:', token); // Log the token for debugging

    if (!token) {
        console.error('No token found in cookies');
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) {
            console.error('Token verification failed:', err.message);
            return res.status(401).json({ success: false, message: 'Invalid token' });
        }
        req.user = decoded;
        next();
    });
};

// Add this route to check token expiration
app.get('/check-token-expiration', verifyToken, (req, res) => {
    const token = req.cookies.token;

    try {
        // Verify the token and decode it
        const decodedToken = jwt.verify(token, SECRET_KEY);
        const expirationTime = decodedToken.exp * 1000; // Convert to milliseconds
        const currentTime = Date.now();
        const timeLeft = expirationTime - currentTime;

        // Return the time left in JSON format
        res.status(200).json({ timeLeft });
    } catch (error) {
        // Return a JSON error response
        res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
});

// Handle Registration
app.post('/register', async (req, res) => {
    const { firstName, middleName, surname, mobile, email, gender, password } = req.body;

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    try {
        const existingData = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Sheet1!A:G',
        });

        const uniqueId = existingData.data.values.length;

        await sheets.spreadsheets.values.append({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Sheet1!A:H',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[firstName, middleName, surname, mobile, email, gender, password, uniqueId]],
            },
        });

        res.status(200).send('Registration successful');
    } catch (err) {
        console.error('Error writing to registration sheet:', err);
        res.status(500).send('Error saving registration data');
    }
});

// Handle Login
app.post('/login', async (req, res) => {
    const { emailOrMobile, password } = req.body;
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Sheet1!A:H',
        });

        const rows = response.data.values;

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'No data found' });
        }

        const user = rows.find(
            (row) =>
                row[3] === emailOrMobile || // Match Mobile
                row[4]?.toLowerCase() === emailOrMobile.toLowerCase() // Match Email
        );

        if (user) {
            if (user[6] === password) {
                // Generate JWT
                const token = jwt.sign({ email: user[4], uniqueID: user[7]}, SECRET_KEY, { expiresIn: '1h' });

                // Set JWT in an HTTP-only cookie
                res.cookie('token', token, {
                    httpOnly: true,
                    secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
                    sameSite: 'strict', // Prevent CSRF attacks
                    maxAge: 3600000, // 1 hour
                });

                console.log("Created On login: ", token);

                return res.status(200).json({ success: true, message: 'Login successful' });
            } else {
                return res.status(401).json({ success: false, message: 'Incorrect password' });
            }
        } else {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
    } catch (error) {
        console.error('Error validating login:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// app.post('/set-spreadsheet-id', async (req, res) => {
//     const { spreadsheetId } = req.body;

//     if (!spreadsheetId) {
//         return res.status(400).json({ success: false, message: 'Spreadsheet ID is required.' });
//     }

//     try {
//         // Store the spreadsheet ID in the environment or database
//         process.env.REGISTRATION_SPREADSHEET_ID = spreadsheetId;

//         res.status(200).json({ success: true, message: 'Spreadsheet ID set successfully.' });
//     } catch (err) {
//         console.error('Error setting spreadsheet ID:', err);
//         res.status(500).json({ success: false, message: 'Failed to set spreadsheet ID.' });
//     }
// });
app.post('/set-spreadsheet', verifyToken, async (req, res) => {
    const { spreadsheetId, spreadsheetName } = req.body;
    const { user } = req;

    if (!spreadsheetId || !spreadsheetName) {
        return res.status(400).json({ success: false, message: 'Spreadsheet ID and name are required.' });
    }

    try {
        const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

        // Update "Sheet1" with the spreadsheet ID and name
        const sheet1Response = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Sheet1!A:L', // Fetch all columns from A to L
        });

        const sheet1Rows = sheet1Response.data.values || [];

        // Find the row index of the logged-in user using their Unique ID (column H, index 7)
        const userRowIndex = sheet1Rows.findIndex((row) => row[7] === user.uniqueID);

        if (userRowIndex === -1) {
            // If the user's row is not found, return an error
            return res.status(404).json({ success: false, message: 'User row not found in Sheet1.' });
        }

        // Get the existing spreadsheet IDs and names from columns K and L
        const existingSpreadsheetIds = sheet1Rows[userRowIndex][10] || ''; // Column K (index 10)
        const existingSpreadsheetNames = sheet1Rows[userRowIndex][11] || ''; // Column L (index 11)

        // Append the new spreadsheet ID and name to the existing ones
        const updatedSpreadsheetIds = existingSpreadsheetIds
            ? `${existingSpreadsheetIds},${spreadsheetId}`
            : spreadsheetId;

        const updatedSpreadsheetNames = existingSpreadsheetNames
            ? `${existingSpreadsheetNames},${spreadsheetName}`
            : spreadsheetName;

        // Update the Spreadsheet ID (column K) and Spreadsheet Name (column L) in the user's row
        await sheets.spreadsheets.values.update({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: `Sheet1!K${userRowIndex + 1}:L${userRowIndex + 1}`, // Columns K and L
            valueInputOption: 'RAW',
            resource: {
                values: [[updatedSpreadsheetIds, updatedSpreadsheetNames]],
            },
        });

        // Update "SpreadSheetID" sheet with unique ID, spreadsheet ID, and name
        const spreadsheetIdResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'SpreadSheetID!A:C', // Fetch columns A (uniqueID), B (spreadsheetId), and C (spreadsheetName)
        });

        const spreadsheetIdRows = spreadsheetIdResponse.data.values || [];

        // Find the row index of the logged-in user using their Unique ID (column A, index 0)
        const userSpreadsheetRowIndex = spreadsheetIdRows.findIndex((row) => row[0] === user.uniqueID);

        if (userSpreadsheetRowIndex === -1) {
            // If the user doesn't have an entry, append a new row with unique ID, spreadsheet ID, and name
            await sheets.spreadsheets.values.append({
                spreadsheetId: REGISTRATION_SPREADSHEET_ID,
                range: 'SpreadSheetID!A:C',
                valueInputOption: 'RAW',
                resource: {
                    values: [[user.uniqueID, spreadsheetId, spreadsheetName]],
                },
            });
        } else {
            // If the user already has an entry, append the new spreadsheet ID and name to the existing ones
            const existingSpreadsheetIds = spreadsheetIdRows[userSpreadsheetRowIndex][1] || ''; // Column B (index 1)
            const existingSpreadsheetNames = spreadsheetIdRows[userSpreadsheetRowIndex][2] || ''; // Column C (index 2)

            const updatedSpreadsheetIds = existingSpreadsheetIds
                ? `${existingSpreadsheetIds},${spreadsheetId}`
                : spreadsheetId;

            const updatedSpreadsheetNames = existingSpreadsheetNames
                ? `${existingSpreadsheetNames},${spreadsheetName}`
                : spreadsheetName;

            // Update the existing row with the updated spreadsheet IDs and names
            await sheets.spreadsheets.values.update({
                spreadsheetId: REGISTRATION_SPREADSHEET_ID,
                range: `SpreadSheetID!A${userSpreadsheetRowIndex + 1}:C${userSpreadsheetRowIndex + 1}`, // Update columns A, B, and C
                valueInputOption: 'RAW',
                resource: {
                    values: [[user.uniqueID, updatedSpreadsheetIds, updatedSpreadsheetNames]],
                },
            });
        }

        res.status(200).json({ success: true, message: 'Spreadsheet ID and name appended successfully in both sheets.' });
    } catch (err) {
        console.error('Error updating sheets:', err);
        res.status(500).json({ success: false, message: 'Failed to update sheets.' });
    }
});

app.get('/get-active-spreadsheet', verifyToken, async (req, res) => {
    try {
        res.status(200).json({ success: true, activeSpreadsheetId });
    } catch (err) {
        console.error('Error fetching active spreadsheet:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch active spreadsheet.' });
    }
});

app.get('/get-spreadsheet-headers', verifyToken, async (req, res) => {
    const { spreadsheetId } = req.query;

    if (!spreadsheetId) {
        return res.status(400).json({ message: 'Spreadsheet ID is required.' });
    }

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    try {
        // Fetch the first row (headers) of the active spreadsheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Sheet1!1:1', // Fetch only the first row (headers)
        });

        const headers = response.data.values ? response.data.values[0] : [];

        if (!headers || headers.length === 0) {
            return res.status(404).json({ message: 'No headers found in the spreadsheet.' });
        }

        res.status(200).json({ headers });
    } catch (error) {
        console.error('Error fetching spreadsheet headers:', error.message);
        res.status(500).json({ message: 'Failed to fetch spreadsheet headers.' });
    }
});
  
  // Endpoint to fetch all spreadsheets for the logged-in user
  app.get('/get-spreadsheets', verifyToken, async (req, res) => {
    const { user } = req;

    try {
        const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

        // Fetch columns K (Spreadsheet ID) and L (Spreadsheet Name) from Sheet1
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Sheet1!A:L', // Fetch all columns from A to L
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'No spreadsheets found.' });
        }

        // Find the row corresponding to the logged-in user using their Unique ID (column H, index 7)
        const userRow = rows.find((row) => row[7] === user.uniqueID);

        if (!userRow) {
            return res.status(404).json({ success: false, message: 'No spreadsheets found for the user.' });
        }

        // Get the spreadsheet IDs and names from columns K (index 10) and L (index 11)
        const spreadsheetIds = userRow[10] || ''; // Column K (Spreadsheet ID)
        const spreadsheetNames = userRow[11] || ''; // Column L (Spreadsheet Name)

        // Split the comma-separated values into arrays
        const idList = spreadsheetIds.split(',');
        const nameList = spreadsheetNames.split(',');

        // Combine the IDs and names into an array of objects
        const userSpreadsheets = idList.map((id, index) => ({
            id: id.trim(), // Remove any extra spaces
            name: nameList[index]?.trim() || 'Unnamed Spreadsheet', // Handle missing names
        }));

        res.status(200).json({ success: true, spreadsheets: userSpreadsheets });
    } catch (err) {
        console.error('Error fetching spreadsheets:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch spreadsheets.' });
    }
});

let activeSpreadsheetId = null; // Store the active spreadsheet ID in memory (or use a database for persistence)

app.post('/set-active-spreadsheet', verifyToken, async (req, res) => {
    const { spreadsheetId } = req.body;

    if (!spreadsheetId) {
        return res.status(400).json({ success: false, message: 'Spreadsheet ID is required.' });
    }

    try {
        // Update the active spreadsheet ID
        activeSpreadsheetId = spreadsheetId;

        res.status(200).json({ success: true, message: 'Active spreadsheet updated successfully.' });
    } catch (err) {
        console.error('Error setting active spreadsheet:', err);
        res.status(500).json({ success: false, message: 'Failed to set active spreadsheet.' });
    }
}); 

// Handle Logout
app.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.status(200).json({ success: true, message: 'Logout successful' });
});

// Fetch User Data (Protected Route)
app.get('/fetch-user', verifyToken, async (req, res) => {
    const { email } = req.user; // Get email from JWT payload

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Sheet1!A:K',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return res.status(404).send('No data found in the spreadsheet.');
        }

        // Find the user with the matching email
        const headers = rows[0]; // First row contains headers
        const userData = rows.slice(1).find((row) => row[4] === email); // Assuming email is in the 5th column (index 4)

        if (!userData) {
            return res.status(404).send('User not found.');
        }

        // Map headers to user data
        const user = {
            firstName: userData[0],
            middleName: userData[1],
            surname: userData[2],
            mobile: userData[3],
            email: userData[4],
            gender: userData[5],
            profilePic: null, // Add profile picture URL if available
        };

        res.status(200).json(user); // Return the user's data as JSON
    } catch (err) {
        console.error('Error fetching data from spreadsheet:', err.message);
        res.status(500).send('Error fetching data from the spreadsheet');
    }
});

app.get('/fetch-registrations', verifyToken, async (req, res) => {
    if (!activeSpreadsheetId) {
        return res.status(400).json({ success: false, message: 'No active spreadsheet set.' });
    }

    try {
        const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

        // Fetch data from the active spreadsheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: activeSpreadsheetId,
            range: 'Sheet1!A:Z', // Adjust the range as needed
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'No data found in the spreadsheet.' });
        }

        // Return the rows directly (including the header row)
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching data from spreadsheet:', err.message);
        res.status(500).json({ success: false, message: 'Error fetching data from the spreadsheet' });
    }
});
// app.get('/fetch-registrations', async (req, res) => {
//     const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  
//     try {
//       // Read the spreadsheetId from config.json
//       const config = readConfig();
//       const spreadsheetId = config.spreadsheetId;
  
//       if (!spreadsheetId) {
//         return res.status(400).json({ success: false, message: 'Spreadsheet ID is not set.' });
//       }
  
//       // Fetch data from the spreadsheet
//       const response = await sheets.spreadsheets.values.get({
//         spreadsheetId: spreadsheetId, // Use the spreadsheetId from config.json
//         range: 'Sheet1!A:K',
//       });
  
//       const rows = response.data.values;
//       if (!rows || rows.length === 0) {
//         return res.status(404).send('No data found in the spreadsheet.');
//       }
  
//       res.status(200).json(rows);
//     } catch (err) {
//       console.error('Error fetching data from spreadsheet:', err.message);
//       res.status(500).send('Error fetching data from the spreadsheet');
//     }
//   });



app.post('/edit-profile', verifyToken, async (req, res) => {
    const { firstName, middleName, surname, mobile, email, gender } = req.body;
    const { email: userEmail } = req.user; // Get email from JWT payload

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    try {
        // Fetch the current data from the spreadsheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Sheet1!A:K',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return res.status(404).send('No data found in the spreadsheet.');
        }

        // Find the user with the matching email
        const userRowIndex = rows.slice(1).findIndex((row) => row[4] === userEmail) + 1; // +1 to account for header row

        if (userRowIndex === -1) {
            return res.status(404).send('User not found.');
        }

        // Update the user's details in the spreadsheet
        const updateRange = `Sheet1!A${userRowIndex + 1}:G${userRowIndex + 1}`; // Adjust for 1-based index in Sheets API
        await sheets.spreadsheets.values.update({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[firstName, middleName, surname, mobile, email, gender, rows[userRowIndex][6]]], // Keep the password unchanged
            },
        });

        res.status(200).json({ success: true, message: 'Profile updated successfully' });
    } catch (err) {
        console.error('Error updating profile:', err.message);
        res.status(500).send('Error updating profile');
    }
});

// Handle Edit Row in Table
app.post('/edit-row', async (req, res) => {
    const { uniqueId, firstName, middleName, surname, mobile, email, gender } = req.body;

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    try {
        // Fetch the current data from the spreadsheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Sheet1!A:K',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return res.status(404).send('No data found in the spreadsheet.');
        }

        // Find the row index of the user with the matching uniqueId
        const userRowIndex = rows.findIndex((row) => row[7] === uniqueId.toString());

        if (userRowIndex === -1) {
            return res.status(404).send('User not found.');
        }

        // Update the user's details in the spreadsheet
        const updateRange = `Sheet1!A${userRowIndex + 1}:G${userRowIndex + 1}`; // Adjust for 1-based index in Sheets API
        await sheets.spreadsheets.values.update({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[firstName, middleName, surname, mobile, email, gender, rows[userRowIndex][6]]], // Keep the password unchanged
            },
        });

        res.status(200).json({ success: true, message: 'Row updated successfully' });
    } catch (err) {
        console.error('Error updating row:', err.message);
        res.status(500).send('Error updating row');
    }
});

app.delete('/delete-user', verifyToken, async (req, res) => {
    const { uniqueId } = req.body;

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    try {
        // Fetch the current data from the main spreadsheet
        const mainSheetResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Sheet1!A:K',
        });

        const mainSheetRows = mainSheetResponse.data.values;
        if (!mainSheetRows || mainSheetRows.length === 0) {
            return res.status(404).send('No data found in the main spreadsheet.');
        }

        // Find the row index of the user with the matching uniqueId in the main sheet
        const userRowIndex = mainSheetRows.findIndex((row) => row[7] === uniqueId.toString());

        if (userRowIndex === -1) {
            return res.status(404).send('User not found in the main sheet.');
        }

        // Delete the row from the main spreadsheet
        await sheets.spreadsheets.values.clear({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: `Sheet1!A${userRowIndex + 1}:K${userRowIndex + 1}`, // Adjust for 1-based index in Sheets API
        });

        // Fetch the current data from the group sheet
        const groupSheetResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Group!A:E', // Adjust the range based on your group sheet
        });

        const groupSheetRows = groupSheetResponse.data.values;
        if (!groupSheetRows || groupSheetRows.length === 0) {
            return res.status(404).send('No data found in the group sheet.');
        }

        // Update each group to remove the deleted user
        for (let i = 1; i < groupSheetRows.length; i++) { // Start from 1 to skip header
            const groupMembers = groupSheetRows[i][2].split(','); // Assuming group members are in column C
            const updatedMembers = groupMembers.filter(member => member.trim() !== uniqueId.toString()).join(',');

            if (updatedMembers !== groupSheetRows[i][2]) {
                // Update the group members in the group sheet
                await sheets.spreadsheets.values.update({
                    spreadsheetId: REGISTRATION_SPREADSHEET_ID,
                    range: `Group!C${i + 1}`, // Adjust for 1-based index in Sheets API
                    valueInputOption: 'RAW',
                    resource: {
                        values: [[updatedMembers]],
                    },
                });
            }
        }

        res.status(200).json({ success: true, message: 'User deleted successfully and removed from all groups.' });
    } catch (err) {
        console.error('Error deleting user:', err.message);
        res.status(500).send('Error deleting user');
    }
});

app.delete('/delete-multiple-users', verifyToken, async (req, res) => {
    const { uniqueIds } = req.body; // Array of uniqueIds to delete

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    try {
        // Fetch the current data from the main spreadsheet (Sheet1)
        const mainSheetResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Sheet1!A:K',
        });

        const mainSheetRows = mainSheetResponse.data.values;
        if (!mainSheetRows || mainSheetRows.length === 0) {
            return res.status(404).send('No data found in the main spreadsheet.');
        }

        // Find the row indices of the users with matching uniqueIds in the main sheet
        const userRowIndices = uniqueIds.map((uniqueId) =>
            mainSheetRows.findIndex((row) => row[7] === uniqueId.toString())
        );

        // Delete the rows from the main spreadsheet (Sheet1)
        for (const rowIndex of userRowIndices) {
            if (rowIndex !== -1) {
                await sheets.spreadsheets.values.clear({
                    spreadsheetId: REGISTRATION_SPREADSHEET_ID,
                    range: `Sheet1!A${rowIndex + 1}:K${rowIndex + 1}`, // Adjust for 1-based index in Sheets API
                });
            }
        }

        // Fetch the current data from the group sheet
        const groupSheetResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Group!A:E', // Adjust the range based on your group sheet
        });

        const groupSheetRows = groupSheetResponse.data.values;
        if (!groupSheetRows || groupSheetRows.length === 0) {
            return res.status(404).send('No data found in the group sheet.');
        }

        // Update each group to remove the deleted users
        for (let i = 1; i < groupSheetRows.length; i++) { // Start from 1 to skip header
            const groupMembers = groupSheetRows[i][2].split(','); // Assuming group members are in column C
            const updatedMembers = groupMembers.filter(
                (member) => !uniqueIds.includes(member.trim())
            ).join(',');

            if (updatedMembers !== groupSheetRows[i][2]) {
                // Update the group members in the group sheet
                await sheets.spreadsheets.values.update({
                    spreadsheetId: REGISTRATION_SPREADSHEET_ID,
                    range: `Group!C${i + 1}`, // Adjust for 1-based index in Sheets API
                    valueInputOption: 'RAW',
                    resource: {
                        values: [[updatedMembers]],
                    },
                });
            }
        }

        res.status(200).json({ success: true, message: 'Users deleted successfully and removed from all groups.' });
    } catch (err) {
        console.error('Error deleting users:', err.message);
        res.status(500).send('Error deleting users');
    }
});

app.post('/create-group', async (req, res) => {
    const { groupName, description, selectedFields, activeSpreadsheetId } = req.body;

    if (!groupName || !selectedFields || selectedFields.length === 0 || !activeSpreadsheetId) {
        return res.status(400).json({ message: 'Group name, selected fields, and active spreadsheet ID are required.' });
    }

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    try {
        // Step 1: Check if the "Group" sheet exists in the active spreadsheet
        const spreadsheetMetadata = await sheets.spreadsheets.get({
            spreadsheetId: activeSpreadsheetId,
        });

        const sheetTitles = spreadsheetMetadata.data.sheets.map(sheet => sheet.properties.title);
        const groupSheetExists = sheetTitles.includes('Group');

        // Step 2: If the "Group" sheet doesn't exist, create it and add headers
        if (!groupSheetExists) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: activeSpreadsheetId,
                resource: {
                    requests: [
                        {
                            addSheet: {
                                properties: {
                                    title: 'Group',
                                },
                            },
                        },
                    ],
                },
            });

            // Add headers to the newly created "Group" sheet
            await sheets.spreadsheets.values.update({
                spreadsheetId: activeSpreadsheetId,
                range: 'Group!A1:D1', // Assuming columns A, B, C, D are for Group ID, Group Name, Description, and Members
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [['Group ID', 'Group Name', 'Description', 'Members']], // Headers for the Group sheet
                },
            });
        }

        // Step 3: Fetch the current data from the main sheet (Sheet1) of the active spreadsheet
        const sheetResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: activeSpreadsheetId,
            range: 'Sheet1!A:Z', // Fetch all columns
        });

        const rows = sheetResponse.data.values;
        if (!rows || rows.length === 0) {
            console.log('No data found in the sheet.');
            return res.status(404).json({ message: 'No data found in the sheet.' });
        }

        // Step 4: Dynamically identify the Unique ID column based on headers
        const headers = rows[0]; // First row contains headers
        console.log("Headers:", headers); // Debug log to verify headers

        // Find the Unique ID column index
        const uniqueIdColumnIndex = headers.findIndex(header => 
            header.toLowerCase().includes('unique') || header.toLowerCase().includes('id')
        );

        if (uniqueIdColumnIndex === -1) {
            console.error('Unique ID column not found in the spreadsheet.');
            return res.status(400).json({ message: 'Unique ID column not found in the spreadsheet.' });
        }

        console.log(`Unique ID column index: ${uniqueIdColumnIndex}`);

        // Step 5: Check if the "Group Name" column exists in Sheet1
        const groupNameColumnHeader = 'Group Name';
        let groupNameColumnIndex = headers.indexOf(groupNameColumnHeader);

        // If the "Group Name" column doesn't exist, create it
        if (groupNameColumnIndex === -1) {
            // Add the "Group Name" column header to the last column
            await sheets.spreadsheets.values.update({
                spreadsheetId: activeSpreadsheetId,
                range: `Sheet1!${String.fromCharCode(65 + headers.length)}1`, // Convert index to column letter (e.g., 0 -> A, 1 -> B)
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [[groupNameColumnHeader]], // Add "Group Name" header
                },
            });

            // Update the headers array to include the new column
            headers.push(groupNameColumnHeader);
            groupNameColumnIndex = headers.length - 1; // Last column index
        }

        // Step 6: Generate a new Group ID (for example, a random number for simplicity)
        const groupId = Math.floor(Math.random() * 10000); // You can implement any logic for unique Group ID generation

        // Step 7: Create a list of unique IDs for the group members
        const groupMembers = selectedFields.map(field => {
            if (!field.uniqueId) {
                console.error('Unique ID is missing for field:', field);
                return null; // Skip this field if uniqueId is missing
            }
            return field.uniqueId;
        }).filter(Boolean).join(','); // Use 'uniqueId' to get member IDs

        console.log("Group Members: ", groupMembers); // Debug log to verify the groupMembers string

        // Step 8: Add the group name and members to the "Group" sheet
        await sheets.spreadsheets.values.append({
            spreadsheetId: activeSpreadsheetId,
            range: 'Group!A:D', // Assuming columns A, B, C, D are for Group ID, Group Name, Description, and Members
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[groupId, groupName, description, groupMembers]], // Add group details to the sheet
            },
        });

        // Step 9: Update the "Group Name" column in Sheet1 for each group member
        for (let field of selectedFields) {
            // Ensure field.uniqueId is defined
            if (!field.uniqueId) {
                console.error('Unique ID is missing for field:', field);
                continue; // Skip this field if uniqueId is missing
            }

            // Find the user in the registration sheet by matching their unique ID
            const userRowIndex = rows.findIndex((row) => {
                return row[uniqueIdColumnIndex] && field.uniqueId && row[uniqueIdColumnIndex].toString() === field.uniqueId.toString();
            });

            if (userRowIndex === -1) {
                console.error(`User with unique ID ${field.uniqueId} not found in Sheet1.`);
                continue; // Skip this field if the user is not found
            }

            // Update the "Group Name" column for the user
            const updateRange = `Sheet1!${String.fromCharCode(65 + groupNameColumnIndex)}${userRowIndex + 1}`; // Convert index to column letter (e.g., 0 -> A, 1 -> B)

            // Append the group name to the existing value (if any)
            const currentGroupName = rows[userRowIndex][groupNameColumnIndex] || '';
            const updatedGroupName = currentGroupName ? `${currentGroupName},${groupName}` : groupName;

            await sheets.spreadsheets.values.update({
                spreadsheetId: activeSpreadsheetId,
                range: updateRange,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [[updatedGroupName]], // Update the Group Name column
                },
            });
        }

        res.status(200).json({
            message: `Group "${groupName}" created successfully with ID ${groupId}`,
            groupId: groupId, // Include the new group ID in the response for frontend
        });
    } catch (error) {
        console.error('Error creating group:', error.message);
        res.status(500).json({ message: 'Failed to create the group.' });
    }
});
app.get('/fetch-groups', async (req, res) => {
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const sheetResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: REGISTRATION_SPREADSHEET_ID,
        range: 'Group!A:C',
    });

    const rows = sheetResponse.data.values;
    if (!rows || rows.length === 0) {
        return res.status(404).json([]);
    }

    const groups = rows.slice(1).map(row => ({
        groupId: row[0],
        groupName: row[1],
    }));

    res.json({ groups }); // Ensure the response is an object with a `groups` key
});

app.get('/fetch-group-users', async (req, res) => {
    const { groupName } = req.query;
    console.log('Received groupName:', groupName);

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const sheetResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: REGISTRATION_SPREADSHEET_ID,
        range: 'Sheet1!A:Z',
    });

    const rows = sheetResponse.data.values;
    if (!rows || rows.length === 0) {
        return res.status(404).json({ users: [] });
    }

    const groupColumnIndex = 9; // Group Name is at index 9
    const users = rows.slice(1).filter(row => row[groupColumnIndex] && row[groupColumnIndex].split(',').includes(groupName));

    // Return all columns except Unique ID (index 7), Group ID (index 8), and Group Name (index 9)
    const formattedUsers = users.map(user => ({
        name: user[0], // First Name
        middleName: user[1], // Middle Name
        surname: user[2], // Surname
        mobile: user[3], // Mobile No
        email: user[4], // Email Address
        gender: user[5], // Gender
        password: user[6], // Password
        groupName: user[9]
    }));

    console.log('Formatted Users:', formattedUsers);
    res.json({ users: formattedUsers });
});

// Combine Groups
app.post('/combine-groups', async (req, res) => {
    const { groupNames, newGroupName, description } = req.body;

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    try {
        // Fetch all groups
        const groupResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Group!A:D',
        });

        const groupRows = groupResponse.data.values;
        if (!groupRows || groupRows.length === 0) {
            return res.status(404).send('No groups found.');
        }

        // Fetch all users
        const userResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Sheet1!A:K',
        });

        const userRows = userResponse.data.values;
        if (!userRows || userRows.length === 0) {
            return res.status(404).send('No users found.');
        }

        // Find users in the selected groups
        const selectedUsers = [];
        groupRows.slice(1).forEach((row) => {
            if (groupNames.includes(row[1])) {
                const userIds = row[2].split(',');
                userIds.forEach((id) => {
                    const user = userRows.find((userRow) => userRow[7] === id);
                    if (user && !selectedUsers.includes(user)) {
                        selectedUsers.push(user);
                    }
                });
            }
        });

        // Create a new group with the combined users
        const groupId = Math.floor(Math.random() * 10000); // Generate a unique group ID
        const groupMembers = selectedUsers.map((user) => user[7]).join(',');

        // Append the new group to the Group sheet
        await sheets.spreadsheets.values.append({
            spreadsheetId: REGISTRATION_SPREADSHEET_ID,
            range: 'Group!A:D',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[groupId, newGroupName, groupMembers, description]],
            },
        });

        // Update the Sheet1 sheet with the new group for each user
        for (const user of selectedUsers) {
            const userGroups = user[9] ? user[9].split(',') : [];
            if (!userGroups.includes(newGroupName)) {
                userGroups.push(newGroupName);
                user[9] = userGroups.join(',');

                // Update the user row in Sheet1
                const userRowIndex = userRows.findIndex((row) => row[7] === user[7]);
                await sheets.spreadsheets.values.update({
                    spreadsheetId: REGISTRATION_SPREADSHEET_ID,
                    range: `Sheet1!A${userRowIndex + 1}:K${userRowIndex + 1}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: {
                        values: [user],
                    },
                });
            }
        }

        res.status(200).json({ success: true, message: 'Groups combined successfully' });
    } catch (err) {
        console.error('Error combining groups:', err.message);
        res.status(500).send('Error combining groups');
    }
});

// Add Users to Existing Groups
// Add Users to Existing Groups
app.post('/add-to-existing-groups', async (req, res) => {
    const { groupNames, selectedFields, activeSpreadsheetId } = req.body;

    if (!groupNames || groupNames.length === 0 || !selectedFields || selectedFields.length === 0 || !activeSpreadsheetId) {
        return res.status(400).json({ message: 'Group names, selected fields, and active spreadsheet ID are required.' });
    }

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    try {
        // Step 1: Fetch the headers and data from the "Group" sheet
        const groupResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: activeSpreadsheetId,
            range: 'Group!A:Z', // Fetch all columns
        });

        const groupRows = groupResponse.data.values;
        if (!groupRows || groupRows.length === 0) {
            return res.status(404).json({ message: 'No groups found.' });
        }

        const groupHeaders = groupRows[0]; // First row contains headers

        // Step 2: Dynamically identify the Group Name and Members columns
        const groupNameColumnIndex = groupHeaders.findIndex(header => 
            header.toLowerCase().includes('group') && header.toLowerCase().includes('name')
        );
        const membersColumnIndex = groupHeaders.findIndex(header => 
            header.toLowerCase().includes('members')
        );

        if (groupNameColumnIndex === -1 || membersColumnIndex === -1) {
            return res.status(400).json({ message: 'Group Name or Members column not found in the Group sheet.' });
        }

        // Step 3: Fetch the headers and data from the main sheet (Sheet1)
        const userResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: activeSpreadsheetId,
            range: 'Sheet1!A:Z', // Fetch all columns
        });

        const userRows = userResponse.data.values;
        if (!userRows || userRows.length === 0) {
            return res.status(404).json({ message: 'No users found.' });
        }

        const userHeaders = userRows[0]; // First row contains headers

        // Step 4: Dynamically identify the Unique ID and Group Name columns in Sheet1
        const uniqueIdColumnIndex = userHeaders.findIndex(header => 
            header.toLowerCase().includes('unique') || header.toLowerCase().includes('id')
        );
        const groupNameColumnIndexSheet1 = userHeaders.findIndex(header => 
            header.toLowerCase().includes('group') && header.toLowerCase().includes('name')
        );

        if (uniqueIdColumnIndex === -1 || groupNameColumnIndexSheet1 === -1) {
            return res.status(400).json({ message: 'Unique ID or Group Name column not found in Sheet1.' });
        }

        // Step 5: Update each selected group with the new users
        for (const groupName of groupNames) {
            const groupRowIndex = groupRows.findIndex((row) => row[groupNameColumnIndex] === groupName);
            if (groupRowIndex !== -1) {
                const groupRow = groupRows[groupRowIndex];
                const existingMembers = groupRow[membersColumnIndex] ? groupRow[membersColumnIndex].split(',') : [];
                const newMembers = selectedFields.map((field) => field.uniqueId);

                // Combine existing and new members, ensuring no duplicates
                const updatedMembers = [...new Set([...existingMembers, ...newMembers])].join(',');

                // Update the group in the Google Sheet
                await sheets.spreadsheets.values.update({
                    spreadsheetId: activeSpreadsheetId,
                    range: `Group!${String.fromCharCode(65 + membersColumnIndex)}${groupRowIndex + 1}`, // Convert index to column letter
                    valueInputOption: 'USER_ENTERED',
                    resource: {
                        values: [[updatedMembers]],
                    },
                });
            }
        }

        // Step 6: Update Sheet1 with the new group information for each user
        for (const user of selectedFields) {
            const userRowIndex = userRows.findIndex((row) => row[uniqueIdColumnIndex] === user.uniqueId);
            if (userRowIndex !== -1) {
                const userRow = userRows[userRowIndex];
                const existingGroups = userRow[groupNameColumnIndexSheet1] ? userRow[groupNameColumnIndexSheet1].split(',') : [];
                const updatedGroups = [...new Set([...existingGroups, ...groupNames])].join(',');

                // Update the user's group information in Sheet1
                await sheets.spreadsheets.values.update({
                    spreadsheetId: activeSpreadsheetId,
                    range: `Sheet1!${String.fromCharCode(65 + groupNameColumnIndexSheet1)}${userRowIndex + 1}`, // Convert index to column letter
                    valueInputOption: 'USER_ENTERED',
                    resource: {
                        values: [[updatedGroups]],
                    },
                });
            }
        }

        res.status(200).json({ success: true, message: 'Users added to existing groups successfully' });
    } catch (err) {
        console.error('Error adding users to existing groups:', err.message);
        res.status(500).json({ message: 'Failed to add users to existing groups.' });
    }
});

// const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID; // Replace with your Twilio Account SID
const authToken = process.env.TWILIO_AUTH_TOKEN;   // Replace with your Twilio Auth Token
const client = twilio(accountSid, authToken);

app.post('/send-whatsapp', async (req, res) => {
    const { message, recipients } = req.body;

    if (!message || !recipients || recipients.length === 0) {
        return res.status(400).json({ error: 'Message and recipient details are required.' });
    }

    const formatPhoneNumber = (number) => {
        const cleanedNumber = number.replace(/[^\d+]/g, '');
        const formattedNumber = cleanedNumber.startsWith('+') ? cleanedNumber : `+${cleanedNumber}`;
        return /^\+\d{10,15}$/.test(formattedNumber) ? formattedNumber : null;
    };

    const validRecipients = recipients
        .map((recipient) => {
            const formattedPhone = formatPhoneNumber(recipient.phone);
            if (!formattedPhone) {
                console.log(`Invalid phone number: ${recipient.phone}`);
                return null;
            }
            return {
                ...recipient,
                phone: formattedPhone,
            };
        })
        .filter((recipient) => recipient !== null);

    if (validRecipients.length === 0) {
        return res.status(400).json({ error: 'No valid recipients found.' });
    }

    try {
        const results = await Promise.all(validRecipients.map(async (recipient) => {
            try {
                await client.messages.create({
                    from: 'whatsapp:+14155238886',
                    to: `whatsapp:${recipient.phone}`,
                    body: `Hello ${recipient.firstName} ${recipient.lastName},\n\n${message}`,
                });
                return { ...recipient, status: 'success' };
            } catch (error) {
                console.error(`Error sending WhatsApp message to ${recipient.phone}:`, error.message);
                return { ...recipient, status: 'failed', error: error.message };
            }
        }));

        res.status(200).json({
            success: true,
            message: `Messages sent successfully to ${validRecipients.length} recipients!`,
            results,
        });
    } catch (error) {
        console.error('Error sending WhatsApp messages:', error.message);
        res.status(500).json({ success: false, error: 'Failed to send messages.' });
    }
});


// const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
// const { Api } = require("telegram");

const apiId = process.env.TELEGRAM_API_ID; // Replace with your Telegram API ID
const apiHash = process.env.TELEGRAM_API_HASH; // Replace with your Telegram API Hash
const stringSession = new StringSession("1BQANOTEuMTA4LjU2LjEwMgG7txGYOMPw/bMayqM+O8CAt73p2L0Kz2nnsIwt4R1zOwVi60AVc+lIWD77N/gl9vTntzz+X/e2AGZwfbd/3K1CDUvE16Is7Tvys7BQA9oOcgw67FtZuQAYV7+pXZGtEnr/qKFniD20EcMOfJ/s2xluVJakQoZrkUeAIOcrbJDdsATrjyGqsKnkqTOz9XdQCD2jao7kjybCoR1D1drPZ/xGl7X5EO3YTGwld0FPJ8LjSPYucQ8Ghdzmyzzt9VRu3ucjpvEYqoNw7fPczA0/Suts6E/ZvNkv0nZJ00y8b5M6+ZyJkHL3vjqwk0sAbVrM7Z/r4SXHzJBqsM8QXk2+fdRw2A=="); // Replace with your session string

(async () => {
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.connect();
    console.log("Telegram client connected.");

    app.post("/send-telegram", async (req, res) => {
        const { message, recipients } = req.body;
        console.log("Received Payload:", req.body);
    
        if (!message || !recipients || recipients.length === 0) {
            return res.status(400).json({ error: "Message and recipient details are required." });
        }
    
        try {
            const results = await Promise.all(
                recipients.map(async (recipient) => {
                    const { phone, firstName, middleName, lastName, email } = recipient;
    
                    try {
                        // Add the number as a contact
                        const result = await client.invoke(
                            new Api.contacts.ImportContacts({
                                contacts: [
                                    new Api.InputPhoneContact({
                                        clientId: Math.floor(Math.random() * 100000), // Unique client ID
                                        phone: phone, // Phone number
                                        firstName: firstName || "Unknown",
                                        middleName: middleName || "",
                                        lastName: lastName || "",
                                    }),
                                ],
                            })
                        );
    
                        // Check if the contact was added successfully
                        if (result.users.length > 0) {
                            console.log(`Added ${phone} (${firstName}) as a contact.`);
                        } else {
                            console.log(`Failed to add ${phone} (${firstName}) as a contact.`);
                            return { ...recipient, status: "failed", error: "Failed to add contact" };
                        }
    
                        // Send the message to the contact
                        const user = result.users[0]; // Use the first user returned in the result
                        await client.sendMessage(user.id, { message });
                        console.log(`Message sent to ${phone}`);
                        return { ...recipient, status: "success" };
                    } catch (err) {
                        console.error(`Failed to send message to ${phone}: ${err.message}`);
                        return { ...recipient, status: "failed", error: err.message };
                    }
                })
            );
    
            res.status(200).json({
                success: true,
                message: "Messages sent successfully!",
                results,
            });
        } catch (error) {
            console.error("Error sending messages:", error.message);
            res.status(500).json({ success: false, error: "Failed to send Telegram messages." });
        }
    });
})();



app.post('/send-sms', async (req, res) => {
    const { message, recipients } = req.body;

    console.log('Incoming SMS Request:', req.body);

    if (!message || !recipients || recipients.length === 0) {
        return res.status(400).json({ error: 'Message and recipient details are required.' });
    }

    try {
        const results = await Promise.all(
            recipients.map(async (recipient) => {
                const { phone, firstName, middleName, lastName, email } = recipient;
                const phoneNumber = phone.startsWith('+') ? phone : `+91${phone.trim()}`;

                try {
                    await client.messages.create({
                        from: '+12317427909', // Replace with your Twilio trial phone number
                        to: phoneNumber,
                        body: message,
                    });
                    return { ...recipient, status: "success" };
                } catch (error) {
                    console.error(`Failed to send SMS to ${phoneNumber}:`, error.message);
                    return { ...recipient, status: "failed", error: error.message };
                }
            })
        );

        res.status(200).json({
            success: true,
            message: `SMS sent successfully to ${recipients.length} recipients!`,
            results,
        });
    } catch (error) {
        console.error('Error sending SMS:', error.message);
        res.status(500).json({ success: false, error: 'Failed to send SMS.' });
    }
});

app.listen(5000, () => console.log('Server started on port 5000'));
