// Generate labeled model inputs with the same text projection used in the web app.
import {readFileSync} from 'node:fs';
import {searchCondition,listingSearchTexts} from '../src/search-condition.ts';
const rows=[
['meat','Grass-fed beef steaks','Boneless pork chops','Steak knife set','Wooden desk'],
['furniture','Oak dining table','Leather sofa','Furniture polish spray','Fresh strawberries'],
['bicycle','Seven-speed city bike','Mountain bicycle','Bicycle bell','Camera lens'],
['footwear','Leather hiking boots','Running shoes','Shoe cleaning brush','Handmade vase'],
['musical instruments','Acoustic guitar','Electronic keyboard piano','Guitar lesson workbook','Rain jacket'],
['fresh fruit','Fresh orchard apples','Freshly picked pears','Fruit-scented candle','Drill bits'],
['winter clothing','Insulated snow pants','Warm down parka','Winter tires','Electric kettle'],
['camping equipment','Two-person backpacking tent','Camping stove','Camping trip photo album','Office printer'],
['I am looking for a lamp for my desk.','Adjustable desk lamp','Desktop reading light','Oak desk without a lamp','Skateboard'],
['I want a tool for cutting wood.','Carpenter’s hand saw','Electric circular saw','Wood glue','Tea towels'],
['Please find me a bag for carrying a laptop.','Padded laptop backpack','Laptop carrying case','Laptop power supply','Garden rake'],
['I need something to keep drinks cold.','Insulated cooler box','Mini beverage refrigerator','Electric water boiler','Yoga mat'],
['tools','Claw hammer','Cordless drill','Tool belt','Chicken soup'],
['lighting','Bedside lamp','Ceiling chandelier','Lighting design textbook','Bike pump'],
['seafood','Salmon fillets','Frozen shrimp','Fish tank','Cotton blanket'],
['stationery','Writing paper set','Lined notebooks','Desk organizer tray','Snow tires'],
['baby stroller','Folding pushchair','Infant pram','Stroller rain cover','Baby socks'],
['waterproof jacket','Waterproof raincoat','Seam-sealed rain shell','Water-resistant trousers','Leather wallet'],
['bike repair','Bicycle tune-up service','Puncture repair for bicycles','Bicycle for sale','Phone screen replacement'],
['kitchen appliances','Stand mixer','Electric toaster','Kitchen towel','Garden shears'],
['I need a chair that folds.','Folding camp chair','Foldaway kitchen chair','Fixed oak chair','Picnic blanket'],
['Please find a tent for two people.','Two-person hiking tent','A tent that sleeps two','Solo one-person tent','Sleeping mat'],
['I want headphones without wires.','Bluetooth over-ear headphones','Wireless earbuds','Wired headphones','USB microphone'],
['I am looking for a way to heat soup.','Microwave oven','Countertop hot plate','Soup bowls','Floor rug']
];

const samples=rows.flatMap(([query,...titles],i)=>titles.map((title,j)=>({
  query,title,split:i%2?'test':'train',match:j<2,
  condition:searchCondition(query),texts:listingSearchTexts({side:'offer',title},query)
})));
// Off-topic inventory is common. Teach the head to reject it, without relying on the topic alone.
const training=rows.filter((_,i)=>i%2===0);
for(const [i,[query]] of training.entries()){
  for(const distance of [2,5,8]){
    const title=training[(i+distance)%training.length][1];
    samples.push({query,title,split:'train',match:false,condition:searchCondition(query),
      texts:listingSearchTexts({title,side:'offer'},query)});
  }
}
const suite=process.argv[2] ?? 'titles';
if(suite!=='titles'){
  if(!['challenge','final'].includes(suite))throw Error('Choose titles, challenge or final');
  const groups=JSON.parse(readFileSync(new URL('../tests/fixtures/search-relevance-'+suite+'.json',import.meta.url)));
  const train=samples.filter(sample=>sample.split==='train');
  samples.length=0;
  samples.push(...train);
  for(const group of groups){
    for(const other of suite==='final'?groups:[group]){
      for(const [j,listing] of other.listings.entries()){
        samples.push({query:group.query,title:listing.title,split:'test',match:group===other&&j<2,
          condition:searchCondition(group.query),texts:listingSearchTexts({side:'offer',...listing},group.query)});
      }
    }
  }
}
console.log(JSON.stringify(samples));
