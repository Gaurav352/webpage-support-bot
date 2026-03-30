import axios from "axios";
import * as cheerio from "cheerio";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { ChromaClient } from "chromadb";

dotenv.config();

const url = 'https://www.geeksforgeeks.org';

async function fetchWebpage(url = '') {
    const data = await axios.get(url);
    const $ = cheerio.load(data.data);
    const pageHead = $('head').html();
    const pageBody = $('body').html();
    const internalLinks = [];
    const externalLinks = [];
    $('a').each((_, element) => {
        const link = $(element).attr('href');
        if (link && link.startsWith('/')) return;
        if (link && link.startsWith('http') || link && link.startsWith('https')) {
            externalLinks.push(link);
        } else {
            internalLinks.push(link);
        }
    });
    return { head: pageHead, body: pageBody, internalLinks, externalLinks };
}

const generateVectorEmbeddings = async ({ text }) => {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: text,
    });
    return response.embeddings[0].values;
}


const client = new ChromaClient({});
const WEBSITE_COLLECTION_NAME = "webpage_collection_1";

const addToChromaDB = async ({ url = '', head = '', body = '', embeddings }) => {
    //console.log(body);
    const collection = await client.getOrCreateCollection({ name: WEBSITE_COLLECTION_NAME, embeddingFunction: null });
    await collection.add({
        ids: [url + "_" + Date.now() + Math.random()],
        embeddings: [embeddings],
        metadatas: [{ url, head, body }]
    });
    // console.log('\n\n');
}

const ingest = async (url = '') => {
    console.log("Ingest called");
    await client.deleteCollection({ name: WEBSITE_COLLECTION_NAME });
    const { head, body } = await fetchWebpage(url);
    const trimmedHead = head.slice(0, 8000);
    const trimmedBody = body.slice(0, 8000);
    const headEmbeddings = await generateVectorEmbeddings({ text: trimmedHead });
    await addToChromaDB({ url, head: trimmedHead, embeddings: headEmbeddings });
    const bodyChunks = divideIntoChunks(trimmedBody);
    for (const chunk of bodyChunks) {
        //console.log(chunk);
        const bodyEmbeddings = await generateVectorEmbeddings({ text: chunk });
        await addToChromaDB({ url, body: chunk, embeddings: bodyEmbeddings });
    }




}

const divideIntoChunks = (text, chunkSize = 2000) => {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
}
const ask = async (question) => {
    // 1. Get the Context from Chroma

    const queryEmbeddings = await generateVectorEmbeddings({ text: question });
    const collection = await client.getOrCreateCollection({ 
        name: WEBSITE_COLLECTION_NAME, 
        embeddingFunction: null 
    });
    const data=await collection.get({include: ["metadatas"]});
    console.log("Data in collection: ", data);

    const collectionResults = await collection.query({
        nResults: 3,
        queryEmbeddings: [queryEmbeddings],
    });

    const contextBody = collectionResults.metadatas[0].map((e) => e.body).join("\n---\n");
    
    const sourceUrls = collectionResults.metadatas[0].map((e) => e.url).join(", ");

    const ai = new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
    const response =await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        systemInstruction: `You are a helpful assistant. Use the following webpage context to answer. 
        If the answer isn't in the context, say you don't know.`,
        contents:[{
            role:"user",
            parts: [{ text: `Context: ${contextBody} \n\nQuestion: ${question}` }]
        }]
    })
    console.log("Answer: ", response.candidates[0].content.parts[0].text);
}
const question = "What is GeeksforGeeks?";


await ingest(url);
await ask(question);