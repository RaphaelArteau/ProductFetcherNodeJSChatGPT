/**
 *
 * Author : Raphael Arteau
 *
 * Date : Apr. 2024
 *
 * Description : This is a script that uses Puppeteer to crawl a ecommerce website, starting off at a category pages. It parses
 * all the pages of this category, and parses every product on each page. It grabs its description and highlights, as well as the price
 * and all the information needed to add a basic product to a Wordpress WooCommerce website. Since the site in question is in French, we
 * use Open AI's API to translate it in French easily. It also keeps a record of parsed page to prevent reparsing if they already have been parsed
 *
 * Notes : In order to be published on GitHub, this code has been anonymised.
 * All website-specific information, such as domains, paths, class names, etc. have been removed.
 * You cannot therefore run this code before adapting it to your own needs.
 *
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const axios = require('axios');
const url = require("url");
const path = require("path");
const qs = require('qs');

const OpenAI = require('openai');
const openai = new OpenAI({apiKey: 'your-openai-key'});

async function init() {

    const domain = "https://www.testwebsite.com";
    let tmp;
    try{

        tmp = await fs.readFileSync('memory.txt');
        tmp = JSON.parse(tmp);
    }catch(e){
        console.log(e)
        tmp = {
            processed : []
        }
    }
    const data = tmp;

    const url = (page) => `${domain}/product/page/?page=${page}`;


    let pageNumber = 1;


    // Launch a headless browser
    const browser = await puppeteer.launch({ headless: false });
    const categoryPage = await browser.newPage();
    await categoryPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');


    let categoryPageResponse = await categoryPage.goto(url(pageNumber), {waitUntil: 'networkidle0'});
    let items, productInfo, elementsToTranslate, elementsTranslated, contents, translation;
    const productPage = await browser.newPage();
    await productPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    while(categoryPageResponse.status() != 404){
        await categoryPage.waitForSelector('.a-query-selector');
        items = await categoryPage.evaluate(() => {
            const elements = document.querySelectorAll('.a-query-selector');
            const itemsArray = Array.from(elements).map(element => {
                let ret = {};
                for (const attr of element.attributes) ret[attr.name] = attr.value;
                return ret;
            });
            return itemsArray;
        });
        for (const item of items) {


            if(data.processed.indexOf(item.sku) > -1) continue;

            await productPage.goto(`${domain}${item.href}`, {waitUntil: 'networkidle2'});

            productInfo = await productPage.evaluate(() => {
                //Using Vanilla Javascript here because the website being parsed doesn't include jQuery
                let ret = {};
                let metadata;
                let scripts = document.querySelectorAll('script-tag');
                for(let script of scripts){
                    if(script.innerHTML.indexOf('"confirm it contains something"') > -1){
                        metadata = JSON.parse(script.innerHTML);
                    }
                }
                ret['images'] = metadata.image;
                ret['highlights'] = document.getElementsByClassName('a-class-name')[0].innerHTML;
                ret['description'] = document.getElementsByClassName('a-class-name')[0].innerHTML;

                return ret;
            });

            let response, writer, parsed, newPath, cleanedImages = [];
            for (const image of productInfo.images) {
                response = await axios.get(image, {
                    responseType: 'stream'
                });

                parsed = new URL(image);
                newPath = 'images/'+path.basename(parsed.pathname);
                cleanedImages.push({
                    name : path.basename(parsed.pathname),
                    path : newPath,
                    wp : {}
                });

                writer = fs.createWriteStream(newPath);

                await new Promise((resolve, reject) => {
                    writer.on('finish', () => {
                        resolve()
                    });
                    writer.on('error', (err) => {
                        console.log(err)
                        reject()
                    });
                    response.data.pipe(writer);

                });

            }
            let formData, image;
            for (const key in cleanedImages) {
                image = cleanedImages[key];
                formData = new FormData();
                formData.append("file", new Blob([fs.readFileSync(image.path)]), image.name);
                response = await axios.post('/wp-json/wp/v2/media/', formData, {
                    //Implement your auth here
                    headers: {
                        'Content-Type': 'multipart/form-data',
                        'Content-Disposition' : `form-data; filename="${image.name}"`
                    }
                });
                cleanedImages[key].wp = response.data;
            }

            elementsToTranslate = {
                title : {
                    contents : item.name,
                    message : "You translate the product description from English to French... Add more details here"
                },
                highlights : {
                    contents : productInfo.highlights,
                    message : "You translate the product description from English to French... Add more details here"
                },
                description : {
                    contents : productInfo.description,
                    message : "You translate the product description from English to French... Add more details here"
                }
            }

            elementsTranslated = {};
            for (const element in elementsToTranslate) {
                let c = elementsToTranslate[element];
                translation = await translate(element, c.contents, c.message);
                elementsTranslated[element] = translation;
            }

            let postData = {
                name: elementsTranslated.title,
                type: "simple",
                regular_price: (item.price / 100) + 100,
                description: elementsTranslated.description,
                short_description: elementsTranslated.highlights,
                stock_status : 'instock',
                meta_data : [{
                    key : 'original',
                    value : item.sku
                }],
                images: cleanedImages.map(image => image.wp)
            }

            response = await axios.post('/wp-json/wc/v3/products', qs.stringify(postData), {
                //auth here
            });

            if(!(typeof response.data.id !== undefined && response.data.id > 0)){
                console.log(response);
                process.exit();
            }

            for (const image of cleanedImages) await fs.unlinkSync(image.path);
            data.processed.push(item.sku);
            await fs.writeFileSync("memory.txt", JSON.stringify(data))

        }

        pageNumber++;
        categoryPageResponse = await categoryPage.goto(url(pageNumber), {waitUntil: 'networkidle0'});
    }
}

async function translate(element, message, system){
    const completion = await openai.chat.completions.create({
        messages: [
            {
                role: "system",
                content: system,
            },
            {
                role: "user",
                content: message
            },
        ],
        model: "gpt-3.5-turbo-0125",
    });
    return completion.choices[0].message.content;
}

init();

