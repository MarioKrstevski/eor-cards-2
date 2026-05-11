"""Import PAEA EOR topic lists as v2 curriculum."""
import json
import urllib.request
import urllib.error

def n(name, children=None):
    return {"name": name, "children": children or []}

def topics(*names):
    return [n(name) for name in names]

curriculum = [
    n("Emergency Medicine", [
        n("Cardiovascular", topics(
            "Acute/subacute bacterial endocarditis", "Angina", "Arrhythmias",
            "Cardiac tamponade", "Chest pain",
            "Conduction disorders (atrial fibrillation/flutter, supraventricular tachycardia, bundle branch block, ventricular tachycardia/fibrillation, premature beats)",
            "Coronary heart disease (non-ST acute myocardial infarction, ST segment elevation acute myocardial infarction, angina pectoris, unstable angina, Prinzmetal/variant angina)",
            "Dyspnea on exertion", "Edema", "Heart failure", "Hypertensive emergencies",
            "Hypotension (cardiogenic shock, orthostatic hypotension)", "Orthopnea", "Palpitations",
            "Pericardial effusion", "Peripheral vascular disease", "Syncope",
            "Valvular disease (aortic stenosis, aortic regurgitation, mitral stenosis, mitral regurgitation)",
            "Vascular disease (aortic aneurysm/dissection, arterial occlusion/thrombosis, phlebitis)",
        )),
        n("Orthopedics/Rheumatology", topics(
            "Back strain/sprain", "Bursitis/tendonitis", "Cauda equina", "Costochondritis",
            "Ecchymosis/erythema", "Fractures/dislocations (shoulder, forearm/wrist/hand, hip, knee, ankle/foot)",
            "Gout", "Herniated disk", "Low back pain", "Osteomyelitis", "Pain",
            "Septic arthritis", "Soft tissue injuries", "Sprains/strains", "Swelling/deformity",
        )),
        n("Gastrointestinal/Nutritional", topics(
            "Abdominal pain", "Acute appendicitis", "Acute cholecystitis", "Acute hepatitis",
            "Acute pancreatitis", "Anal fissure/fistula/abscess", "Anorexia",
            "Change in bowel habits/diarrhea/constipation", "Cholangitis", "Cirrhosis",
            "Diarrhea/constipation", "Diverticular disease", "Esophagitis", "Gastritis",
            "Gastroenteritis", "Gastrointestinal bleeding", "Giardiasis and other parasitic infections",
            "Heartburn", "Hematemesis", "Hemorrhoids (thrombosed)",
            "Hernia (incarcerated/strangulated)", "Infectious diarrhea",
            "Inflammatory bowel disease/toxic megacolon", "Ischemic bowel disease", "Jaundice",
            "Mallory-Weiss tear", "Melena; bleeding per rectum", "Nausea/vomiting",
            "Obstruction (small bowel, large bowel, volvulus)", "Peptic ulcer disease",
        )),
        n("Pulmonology", topics(
            "Acute bronchiolitis", "Acute bronchitis", "Acute epiglottitis",
            "Acute respiratory distress syndrome", "Asthma", "Croup", "Foreign body aspiration",
            "Hemoptysis", "Influenza", "Lung cancer", "Pertussis", "Pleural effusion",
            "Pleuritic chest pain",
            "Pneumonia (bacterial, viral, fungal, human immunodeficiency virus-related)",
            "Pneumothorax", "Pulmonary embolism", "Respiratory syncytial virus",
            "Shortness of breath", "Tuberculosis", "Wheezing",
        )),
        n("Neurology", topics(
            "Altered level of consciousness/coma", "Bell palsy", "Encephalitis",
            "Epidural/subdural hematoma", "Guillain-Barré syndrome",
            "Head trauma/concussion/contusion", "Headache (migraine, cluster, tension)",
            "Intracerebral hemorrhage", "Loss of consciousness/change in mental status",
            "Loss of coordination/ataxia", "Loss of memory", "Meningitis",
            "Numbness/paresthesia", "Seizure (symptom)", "Seizure disorders", "Spinal cord injury",
            "Status epilepticus", "Stroke", "Subarachnoid hemorrhage/cerebral aneurysm",
            "Syncope", "Transient ischemic attack", "Vertigo", "Weakness/paralysis",
        )),
        n("ENOT/Ophthalmology", topics(
            "Acute laryngitis", "Acute otitis media", "Acute pharyngitis (viral, bacterial)",
            "Acute sinusitis", "Allergic rhinitis", "Barotrauma", "Blepharitis",
            "Blow-out fracture", "Conjunctivitis", "Corneal abrasion/ulcer", "Dacryoadenitis",
            "Dental abscess", "Ear pain", "Epiglottitis", "Epistaxis",
            "Foreign body (eye, ear, nose)", "Glaucoma (acute angle closure)", "Hyphema",
            "Labyrinthitis", "Macular degeneration (wet)", "Mastoiditis", "Nasal congestion",
            "Optic neuritis", "Orbital cellulitis", "Otitis externa", "Papilledema",
            "Peritonsillar abscess", "Retinal detachment", "Retinal vein occlusion",
            "Sore throat", "Trauma/hematoma (external ear)", "Tympanic membrane perforation",
            "Vertigo", "Vision loss",
        )),
        n("Urology/Renal", topics(
            "Acid/base disorders", "Acute renal failure", "Cystitis", "Dysuria",
            "Epididymitis", "Fluid and electrolyte disorders", "Glomerulonephritis", "Hematuria",
            "Hernias", "Incontinence", "Nephrolithiasis", "Orchitis", "Prostatitis",
            "Pyelonephritis", "Suprapubic/flank pain", "Testicular torsion", "Urethritis",
        )),
        n("Dermatology", topics(
            "Bullous pemphigoid", "Burns", "Cellulitis", "Dermatitis (eczema, contact)",
            "Discharge", "Drug eruptions", "Erysipelas", "Herpes zoster", "Impetigo",
            "Itching", "Lice", "Pilonidal disease", "Pressure sores", "Rash", "Scabies",
            "Spider bites", "Stevens-Johnson syndrome", "Toxic epidermal necrolysis",
            "Urticaria", "Viral exanthems",
        )),
        n("Endocrinology", topics(
            "Adrenal insufficiency", "Cushing disease", "Diabetes insipidus", "Diabetes mellitus",
            "Diabetic ketoacidosis", "Heat/cold intolerance", "Hyperparathyroidism",
            "Hyperthyroidism", "Hypothyroidism", "Nonketotic hyperglycemia", "Palpitations",
            "Thyroiditis", "Tremors",
        )),
        n("Obstetrics/Gynecology", topics(
            "Amenorrhea", "Dysfunctional uterine bleeding", "Ectopic pregnancy", "Endometriosis",
            "Fetal distress", "Intrauterine pregnancy", "Mastitis/breast abscess", "Ovarian cysts",
            "Pelvic inflammatory disease", "Pelvic pain/dysmenorrhea", "Placenta abruption",
            "Placenta previa", "Premature rupture of membranes", "Spontaneous abortion",
            "Vaginal discharge", "Vaginitis",
        )),
        n("Psychiatry/Behavioral Medicine", topics(
            "Anxiety disorders", "Bipolar and related disorders", "Depressive disorders",
            "Neurocognitive disorders", "Panic disorder", "Posttraumatic stress disorder",
            "Schizophrenia spectrum and other psychotic disorders",
            "Spouse or partner neglect/violence", "Substance use disorders", "Suicide",
        )),
        n("Hematology", topics(
            "Acute leukemia", "Anemia", "Aplastic anemia", "Clotting factor disorders",
            "Easy bruising", "Fatigue", "Hemolytic anemia", "Hypercoagulable states",
            "Lymphomas", "Polycythemia", "Sickle cell anemia/crisis", "Thrombocytopenia",
        )),
    ]),

    n("Family Medicine", [
        n("Cardiovascular", topics(
            "Angina", "Arrhythmias", "Chest pain", "Congestive heart failure",
            "Coronary artery disease", "Endocarditis", "Hyperlipidemia", "Hypertension",
            "Hypertriglyceridemia", "Peripheral vascular disease", "Valvular disease",
        )),
        n("Pulmonology", topics(
            "Asthma", "Bronchitis", "Chronic obstructive pulmonary disease", "Lung cancer",
            "Pneumonia", "Sleep disorders", "Tobacco use/dependence", "Tuberculosis",
        )),
        n("Gastrointestinal/Nutritional", topics(
            "Anal fissure", "Appendicitis", "Bowel obstruction", "Cholecystitis/cholelithiasis",
            "Cirrhosis", "Colorectal cancer/colonic polyps", "Diarrhea/constipation", "Esophagitis",
            "Gastritis", "Gastroenteritis", "Gastroesophageal reflux disease",
            "Gastrointestinal bleeding", "Giardiasis and other parasitic infections",
            "Hemorrhoids", "Hiatal hernia", "Inflammatory bowel disease",
            "Irritable bowel syndrome", "Jaundice", "Pancreatitis", "Peptic ulcer disease",
            "Viral hepatitis",
        )),
        n("ENOT/Ophthalmology", topics(
            "Acute/chronic sinusitis", "Allergic rhinitis", "Aphthous ulcers", "Blepharitis",
            "Cholesteatoma", "Conjunctivitis", "Corneal abrasion", "Corneal ulcer",
            "Dacryocystitis", "Ectropion", "Entropion", "Epistaxis", "Glaucoma", "Hordeolum",
            "Hyphema", "Labyrinthitis", "Laryngitis", "Macular degeneration", "Ménière disease",
            "Nasal polyps", "Otitis externa", "Otitis media", "Papilledema", "Parotitis",
            "Peritonsillar abscess", "Pharyngitis/tonsillitis", "Pterygium", "Retinal detachment",
            "Retinal vascular occlusion", "Retinopathy", "Sialadenitis", "Tinnitus",
            "Tympanic membrane perforation",
        )),
        n("Obstetrics/Gynecology", topics(
            "Breast cancer", "Breast mass", "Cervical cancer", "Contraception", "Cystocele",
            "Dysfunctional uterine bleeding", "Dysmenorrhea", "Intrauterine pregnancy",
            "Menopause", "Pelvic inflammatory disease", "Rectocele", "Spontaneous abortion",
            "Vaginitis",
        )),
        n("Orthopedics/Rheumatology", topics(
            "Acute and chronic lower back pain", "Bursitis/tendonitis", "Costochondritis",
            "Fibromyalgia", "Ganglion cysts", "Gout", "Osteoarthritis", "Osteoporosis",
            "Overuse syndrome", "Plantar fasciitis", "Reactive arthritis", "Rheumatoid arthritis",
            "Sprains/strains", "Systemic lupus erythematosus",
        )),
        n("Neurology", topics(
            "Alzheimer disease", "Bell palsy", "Cerebral vascular accident", "Delirium",
            "Dementia", "Dizziness", "Essential tremor",
            "Headaches (cluster, migraine, tension)", "Parkinson disease", "Seizure disorders",
            "Syncope", "Transient ischemic attack", "Vertigo",
        )),
        n("Dermatology", topics(
            "Acanthosis nigricans", "Acne vulgaris", "Actinic keratosis", "Alopecia",
            "Basal cell carcinoma", "Bullous pemphigoid", "Cellulitis", "Condyloma acuminatum",
            "Dermatitis (eczema, seborrhea)", "Drug eruptions", "Dyshidrosis", "Erysipelas",
            "Erythema multiforme", "Exanthems", "Folliculitis", "Hidradenitis suppurativa",
            "Impetigo", "Kaposi sarcoma", "Lice", "Lichen planus", "Lichen simplex chronicus",
            "Lipomas/epithelial inclusion cysts", "Melanoma", "Melasma",
            "Molluscum contagiosum", "Nummular eczema", "Onychomycosis", "Paronychia",
            "Pilonidal disease", "Pityriasis rosea", "Pressure ulcers", "Psoriasis", "Rosacea",
            "Scabies", "Seborrheic keratosis", "Spider bites", "Stevens-Johnson syndrome",
            "Tinea infections", "Tinea versicolor", "Toxic epidermal necrolysis", "Urticaria",
            "Verrucae", "Vitiligo",
        )),
        n("Endocrinology", topics(
            "Adrenal insufficiency", "Cushing disease", "Diabetes mellitus",
            "Hyperthyroidism", "Hypothyroidism",
        )),
        n("Psychiatry/Behavioral Medicine", topics(
            "Anorexia nervosa", "Anxiety disorders", "Bipolar disorders", "Bulimia nervosa",
            "Insomnia disorder", "Major depressive disorder", "Panic disorder",
            "Posttraumatic stress disorder", "Specific phobia",
            "Spouse or partner neglect/violence", "Substance use disorders", "Suicide",
        )),
        n("Urology/Renal", topics(
            "Balanitis", "Benign prostatic hyperplasia", "Chlamydia", "Cystitis",
            "Epididymitis", "Glomerulonephritis", "Gonorrhea", "Hernias", "Nephrolithiasis",
            "Orchitis", "Prostatitis", "Pyelonephritis", "Testicular cancer", "Urethritis",
        )),
        n("Hematology", topics(
            "Anemia", "Clotting disorders", "Leukemia", "Lymphomas", "Polycythemia",
            "Thrombocytopenia",
        )),
        n("Infectious Diseases", topics(
            "Human immunodeficiency virus", "Influenza", "Lyme disease", "Meningitis",
            "Mononucleosis", "Salmonellosis", "Shigellosis",
        )),
        n("Urgent Care", topics(
            "Acute abdomen", "Allergic reaction/anaphylaxis", "Bites/stings", "Burns",
            "Cardiac failure/arrest", "Deteriorating mental status/unconscious patient",
            "Foreign body aspiration", "Fractures/dislocations", "Hypertensive crisis",
            "Ingesting harmful substances (poisonings)", "Myocardial infarction",
            "Orbital cellulitis", "Pneumothorax", "Pulmonary embolus",
            "Respiratory failure/arrest", "Sprains/strains", "Third trimester bleeding",
        )),
    ]),

    n("Surgery", [
        n("Gastrointestinal", [
            n("Diagnoses", topics(
                "Anal disorders", "Appendicitis", "Bowel obstruction",
                "Cholecystitis/cholelithiasis", "Diverticulitis", "Gastrointestinal bleeding",
                "Hiatal hernia", "Ileus", "Inflammatory bowel disease",
                "Malignancy of the gastrointestinal tract", "Obesity", "Pancreatitis",
                "Peritonitis", "Toxic megacolon",
            )),
            n("Perioperative Risk Assessment and Complications"),
            n("Procedures", topics(
                "Abdominal drains", "Colonoscopy",
                "Endoscopic retrograde cholangiopancreatography", "Endoscopy", "Ileostomy",
                "Nasogastric tubes", "Parenteral nutrition",
                "Percutaneous endoscopic gastronomy tube",
            )),
        ]),
        n("Cardiovascular", [
            n("Diagnoses", topics(
                "Acute arterial occlusion", "Aortic aneurysm", "Aortic dissection",
                "Chronic arterial insufficiency", "Chronic venous insufficiency",
                "Compartment syndrome", "Coronary artery disease", "Carotid artery stenosis",
                "Intestinal ischemia", "Renal vascular disease", "Valvular heart disease",
                "Varicose veins",
            )),
            n("Perioperative Risk Assessment and Complications"),
            n("Procedures", topics(
                "Advanced cardiac life support", "Arteriovenous fistula placement",
                "Central line placement", "Permacath/port placement", "Vascular access",
            )),
        ]),
        n("Pulmonary/Thoracic Surgery", [
            n("Diagnoses", topics(
                "Chylothorax", "Empyema", "Hemothorax", "Lung malignancy",
                "Mediastinal disorders", "Pleural effusion", "Pneumothorax", "Pulmonary nodule",
            )),
            n("Perioperative Risk Assessment and Complications"),
            n("Procedures", topics("Chest tube", "Thoracentesis")),
        ]),
        n("Breast Surgery", [
            n("Diagnoses", topics(
                "Breast abscess", "Benign breast disease", "Carcinoma of the female breast",
                "Carcinoma of the male breast", "Disorders of the augmented breast",
                "Fat necrosis", "Mastitis", "Phyllodes tumor",
            )),
            n("Perioperative Risk Assessment and Complications"),
            n("Procedures", topics("Biopsy")),
        ]),
        n("Dermatologic", [
            n("Diagnoses", topics(
                "Burns", "Cellulitis", "Dermatologic neoplasms", "Epidermal inclusion cyst",
                "Hidradenitis suppurativa", "Lipoma", "Pressure ulcer",
            )),
            n("Perioperative Risk Assessment and Complications"),
            n("Procedures", topics(
                "Aspiration of seroma/hematoma", "Incision and drainage of abscess",
                "Skin biopsy", "Skin graft and flap", "Suturing",
            )),
        ]),
        n("Renal/Genitourinary", [
            n("Diagnoses", topics(
                "Benign prostatic hyperplasia", "Nephrolithiasis", "Paraphimosis/phimosis",
                "Testicular torsion", "Urethral stricture", "Urologic/renal neoplasms",
            )),
            n("Perioperative Risk Assessment and Complications"),
            n("Procedures", topics("Lithotripsy", "Urinary catheterization", "Vasectomy")),
        ]),
        n("Trauma/Acute Care", [
            n("Diagnoses", topics(
                "Acute abdomen", "Alteration in consciousness", "Compound fractures", "Shock",
            )),
            n("Perioperative Risk Assessment and Complications"),
            n("Procedures", topics("Transfusion")),
        ]),
        n("Neurologic/Neurosurgery", [
            n("Diagnoses", topics(
                "Carpal tunnel syndrome", "Epidural hematoma", "Neurologic neoplasms",
                "Subarachnoid hemorrhage",
            )),
            n("Perioperative Risk Assessment and Complications"),
            n("Procedures", topics("Lumbar puncture")),
        ]),
        n("Pain Medicine/Anesthesia", [
            n("Diagnoses", topics(
                "Acute pain", "Chronic pain", "Substance use disorder",
            )),
            n("Perioperative Risk Assessment and Complications"),
            n("Procedures", topics(
                "Endotracheal intubation", "Intravenous line placement",
                "Local and regional anesthesia",
            )),
        ]),
        n("Endocrine", [
            n("Diagnoses", topics(
                "Adrenal disorders", "Endocrine neoplasms", "Parathyroid disorders",
                "Pituitary disorders", "Thyroid disorders",
            )),
            n("Perioperative Risk Assessment and Complications"),
            n("Procedures", topics("Fine needle biopsy")),
        ]),
    ]),

    n("Internal Medicine", [
        n("Cardiovascular", topics(
            "Angina pectoris", "Cardiac arrhythmias/conduction disorders", "Cardiomyopathy",
            "Congestive heart failure", "Coronary vascular disease", "Endocarditis",
            "Heart murmurs", "Hyperlipidemia", "Hypertension", "Myocardial infarction",
            "Myocarditis", "Pericarditis", "Peripheral vascular disease", "Rheumatic fever",
            "Rheumatic heart disease", "Valvular heart disease", "Vascular disease",
        )),
        n("Pulmonology", topics(
            "Acute/chronic bronchitis", "Asthma", "Bronchiectasis", "Carcinoid tumor",
            "Chronic obstructive pulmonary disease", "Cor pulmonale", "Hypoventilation syndrome",
            "Idiopathic pulmonary fibrosis", "Pneumoconiosis",
            "Pneumonia (viral, bacterial, fungal, human immunodeficiency virus-related)",
            "Pulmonary hypertension", "Pulmonary neoplasm", "Sarcoidosis",
            "Solitary pulmonary nodule",
        )),
        n("Gastrointestinal/Nutritional", topics(
            "Acute and chronic hepatitis", "Acute/chronic pancreatitis", "Anal fissure/fistula",
            "Cancer of rectum, colon, esophagus, stomach", "Celiac disease", "Cholangitis",
            "Cholecystitis", "Cholelithiasis", "Cirrhosis", "Crohn disease",
            "Diverticular disease", "Esophageal strictures", "Esophageal varices", "Esophagitis",
            "Gastritis", "Gastroenteritis", "Gastroesophageal reflux disease", "Hemorrhoid",
            "Hepatic cancer", "Hiatal hernia", "Irritable bowel syndrome", "Mallory-Weiss tear",
            "Peptic ulcer disease", "Ulcerative colitis",
        )),
        n("Orthopedics/Rheumatology", topics(
            "Fibromyalgia", "Gout/pseudogout", "Polyarteritis nodosa", "Polymyalgia rheumatica",
            "Polymyositis", "Reactive arthritis", "Rheumatoid arthritis", "Sjögren syndrome",
            "Systemic lupus erythematosus", "Systemic sclerosis (scleroderma)",
        )),
        n("Endocrinology", topics(
            "Acromegaly", "Addison's disease", "Cushing disease", "Diabetes insipidus",
            "Diabetes mellitus (type I & type II)", "Hypercalcemia", "Hypernatremia",
            "Hyperparathyroidism", "Hyperthyroidism/thyroiditis", "Hypocalcemia", "Hyponatremia",
            "Hypoparathyroidism", "Hypothyroidism", "Paget disease of the bone",
            "Pheochromocytoma", "Pituitary adenoma", "Thyroid cancer",
        )),
        n("Neurology", topics(
            "Bell palsy", "Cerebral aneurysm", "Cerebral vascular accident", "Cluster headaches",
            "Coma", "Complex regional pain syndrome", "Concussion", "Delirium", "Dementia",
            "Encephalitis", "Essential tremor", "Giant cell arteritis", "Guillain-Barré syndrome",
            "Huntington disease", "Intracranial tumors", "Meningitis", "Migraine headaches",
            "Multiple sclerosis", "Myasthenia gravis", "Parkinson disease",
            "Peripheral neuropathies", "Seizure disorders", "Syncope", "Tension headaches",
            "Transient ischemic attacks",
        )),
        n("Urology/Renal", topics(
            "Acid base disturbances", "Acute and chronic renal failure",
            "Acute interstitial nephritis", "Benign prostatic hyperplasia", "Bladder cancer",
            "Epididymitis", "Erectile dysfunction", "Glomerulonephritis", "Hydrocele",
            "Hydronephrosis", "Hypervolemia", "Hypovolemia", "Nephritic syndrome", "Nephritis",
            "Polycystic kidney disease", "Prostate cancer", "Prostatitis", "Pyelonephritis",
            "Renal calculi", "Renal cell carcinoma", "Renal vascular disease",
            "Testicular torsion", "Urinary tract infection", "Varicocele",
        )),
        n("Critical Care", topics(
            "Acute abdomen", "Acute adrenal insufficiency", "Acute gastrointestinal bleed",
            "Acute glaucoma", "Acute respiratory distress/failure", "Angina pectoris",
            "Cardiac arrest", "Cardiac arrhythmias and blocks", "Cardiac failure",
            "Cardiac tamponade", "Coma", "Diabetic ketoacidosis/acute hypoglycemia",
            "Hypertensive crisis", "Myocardial infarction", "Pericardial effusion",
            "Pneumothorax", "Pulmonary embolism", "Seizures", "Shock", "Status epilepticus",
            "Thyroid storm",
        )),
        n("Hematology", topics(
            "Acute/chronic leukemia", "Anemia of chronic disease", "Clotting factor disorders",
            "G6PD deficiency anemia", "Hypercoagulable state",
            "Idiopathic thrombocytopenic purpura", "Iron deficiency anemia", "Lymphoma",
            "Multiple myeloma", "Sickle cell anemia", "Thalassemia",
            "Thrombotic thrombocytopenic purpura",
            "Vitamin B12 and folic acid deficiency anemia",
        )),
        n("Infectious Disease", topics(
            "Botulism", "Candidiasis", "Chlamydia", "Cholera", "Cryptococcus",
            "Cytomegalovirus", "Diphtheria", "Epstein-Barr infection", "Gonococcal infections",
            "Herpes simplex infection", "Histoplasmosis",
            "Human immunodeficiency virus infection", "Influenza", "Lyme disease",
            "Parasitic infections", "Pertussis", "Pneumocystis", "Rabies",
            "Rocky Mountain spotted fever", "Salmonellosis", "Shigellosis", "Syphilis",
            "Tetanus", "Toxoplasmosis", "Tuberculosis", "Varicella zoster",
        )),
    ]),

    n("Pediatrics", [
        n("Dermatology", topics(
            "Acne vulgaris", "Androgenetic alopecia", "Atopic dermatitis", "Burns",
            "Contact dermatitis", "Dermatitis (diaper, perioral)", "Drug eruptions",
            "Erythema multiforme", "Exanthems", "Impetigo", "Lice", "Lichen planus",
            "Pityriasis rosea", "Scabies", "Stevens-Johnson syndrome", "Tinea",
            "Toxic epidermal necrolysis", "Urticaria", "Verrucae",
        )),
        n("ENOT/Ophthalmology", topics(
            "Acute otitis media", "Acute pharyngotonsillitis", "Allergic rhinitis",
            "Conjunctivitis", "Epiglottitis", "Epistaxis", "Hearing impairment", "Mastoiditis",
            "Oral candidiasis", "Orbital cellulitis", "Otitis externa", "Peritonsillar abscess",
            "Strabismus", "Tympanic membrane perforation",
        )),
        n("Infectious Disease", topics(
            "Atypical mycobacterial disease", "Epstein-Barr disease", "Erythema infectiosum",
            "Hand-foot-and-mouth disease", "Herpes simplex", "Influenza", "Measles", "Mumps",
            "Pertussis", "Pinworms", "Roseola", "Rubella", "Varicella infection",
        )),
        n("Pulmonology", topics(
            "Acute bronchiolitis", "Asthma", "Croup", "Cystic fibrosis", "Foreign body",
            "Hyaline membrane disease", "Pneumonia (bacterial, viral)",
            "Respiratory syncytial virus",
        )),
        n("Cardiovascular", topics(
            "Acute rheumatic fever", "Atrial septal defect", "Coarctation of the aorta",
            "Hypertrophic cardiomyopathy", "Kawasaki disease", "Patent ductus arteriosus",
            "Syncope", "Tetralogy of Fallot", "Ventricular septal defect",
        )),
        n("Gastrointestinal/Nutritional", topics(
            "Appendicitis", "Colic", "Constipation", "Dehydration", "Duodenal atresia",
            "Encopresis", "Foreign body", "Gastroenteritis", "Gastroesophageal reflux disease",
            "Hepatitis", "Hirschsprung disease", "Inguinal hernia", "Intussusception",
            "Jaundice", "Lactose intolerance", "Niacin deficiencies", "Pyloric stenosis",
            "Umbilical hernia", "Vitamin A deficiency", "Vitamin C deficiency",
            "Vitamin D deficiency",
        )),
        n("Neurology/Developmental", topics(
            "Anticipatory guidance", "Down syndrome", "Febrile seizure",
            "Immunization guidelines", "Meningitis", "Normal growth and development",
            "Seizure disorders", "Teething", "Turner syndrome",
        )),
        n("Psychiatry/Behavioral Medicine", topics(
            "Anxiety disorders", "Attention-deficit/hyperactivity disorder",
            "Autism spectrum disorder", "Child abuse and neglect", "Depressive disorders",
            "Disruptive, impulse-control, and conduct disorders",
            "Feeding or eating disorders", "Suicide",
        )),
        n("Orthopedics/Rheumatology", topics(
            "Avascular necrosis of the proximal femur", "Congenital hip dysplasia",
            "Juvenile rheumatoid arthritis", "Neoplasia of the musculoskeletal system",
            "Nursemaid elbow", "Osgood-Schlatter disease", "Scoliosis",
            "Slipped capital femoral epiphysis",
        )),
        n("Endocrinology", topics(
            "Diabetes mellitus", "Hypercalcemia", "Hyperthyroidism", "Hypothyroidism",
            "Obesity", "Short stature",
        )),
        n("Hematology", topics(
            "Anemia", "Bleeding disorders", "Brain tumors", "Hemophilia", "Lead poisoning",
            "Leukemia", "Lymphoma", "Neutropenia",
        )),
        n("Urology/Renal", topics(
            "Cryptorchidism", "Cystitis", "Enuresis", "Glomerulonephritis", "Hydrocele",
            "Hypospadias", "Paraphimosis", "Phimosis", "Testicular torsion",
            "Vesicourethral reflux",
        )),
    ]),

    n("Psychiatry & Behavioral Health", [
        n("Depressive Disorders; Bipolar and Related Disorders", topics(
            "Bipolar I disorder", "Bipolar II disorder", "Cyclothymic disorder",
            "Major depressive disorder", "Persistent depressive disorder (dysthymia)",
        )),
        n("Anxiety Disorders; Trauma- and Stress-Related Disorders", topics(
            "Generalized anxiety disorder", "Panic disorder", "Phobic disorders",
            "Post-traumatic stress disorder", "Specific phobias",
        )),
        n("Substance-Related Disorders", topics(
            "Alcohol-related disorders", "Cannabis-related disorders",
            "Hallucinogen-related disorders", "Inhalant-related disorders",
            "Opioid-related disorders",
            "Sedative-, hypnotic-, or anxiolytic-related disorders",
            "Stimulant-related disorders", "Tobacco-related disorders",
        )),
        n("Schizophrenia Spectrum and Other Psychotic Disorders", topics(
            "Delusional disorder", "Schizoaffective disorder", "Schizophrenia",
            "Schizophreniform disorder",
        )),
        n("Disruptive, Impulse-Control and Conduct Disorders; Neurodevelopmental Disorders", topics(
            "Attention-deficit/hyperactivity disorder", "Autism spectrum disorder",
            "Conduct disorder", "Oppositional defiant disorder",
        )),
        n("Personality Disorders; Obsessive-Compulsive and Related Disorders", topics(
            "Antisocial personality disorder", "Avoidant personality disorder",
            "Body dysmorphic disorder", "Borderline personality disorder",
            "Dependent personality disorder", "Histrionic personality disorder",
            "Narcissistic personality disorder", "Obsessive-compulsive disorder",
            "Obsessive-compulsive personality disorder", "Paranoid personality disorder",
            "Schizoid personality disorder", "Schizotypal personality disorder",
        )),
        n("Somatic Symptom and Related Disorders; Nonadherence to Medical Treatment", topics(
            "Factitious disorder", "Illness anxiety disorder", "Somatic symptom disorder",
        )),
        n("Feeding or Eating Disorders", topics(
            "Anorexia nervosa", "Bulimia nervosa",
        )),
        n("Paraphilic Disorders; Sexual Dysfunctions", topics(
            "Exhibitionistic disorder", "Female sexual interest/arousal disorder",
            "Fetishistic disorder", "Male hypoactive sexual desire disorder",
            "Pedophilic disorder", "Sexual masochism disorder", "Voyeuristic disorder",
        )),
    ]),

    n("Women's Health", [
        n("Gynecology", [
            n("Menstruation", topics(
                "Amenorrhea", "Dysfunctional uterine bleeding", "Dysmenorrhea", "Menopause",
                "Normal physiology", "Premenstrual dysphoric disorder", "Premenstrual syndrome",
            )),
            n("Infections", topics(
                "Cervicitis (gonorrhea, chlamydia, herpes simplex, human papilloma virus)",
                "Chancroid", "Lymphogranuloma venereum", "Pelvic inflammatory disease",
                "Syphilis",
                "Vaginitis (trichomoniasis, bacterial vaginosis, atrophic vaginitis, candidiasis)",
            )),
            n("Neoplasms", topics(
                "Breast cancer", "Cervical carcinoma", "Cervical dysplasia",
                "Endometrial cancer", "Ovarian neoplasms", "Vaginal/vulvar neoplasms",
            )),
            n("Disorders of the Breast", topics(
                "Breast abscess", "Breast fibroadenoma", "Fibrocystic disease", "Mastitis",
            )),
            n("Structural Abnormalities", topics(
                "Cystocele", "Ovarian torsion", "Rectocele", "Uterine prolapse",
            )),
            n("Other", topics(
                "Contraceptive methods", "Endometriosis", "Infertility", "Leiomyoma",
                "Ovarian cyst", "Sexual assault", "Spouse or partner neglect/violence",
                "Urinary incontinence",
            )),
        ]),
        n("Obstetrics", [
            n("Prenatal Care/Normal Pregnancy", topics(
                "Apgar score", "Fetal position", "Multiple gestation",
                "Normal labor and delivery (stages, duration, mechanism of delivery, monitoring)",
                "Physiology of pregnancy", "Prenatal diagnosis/care",
            )),
            n("Pregnancy Complications", topics(
                "Abortion", "Ectopic pregnancy", "Gestational diabetes",
                "Gestational trophoblastic disease (molar pregnancy, choriocarcinoma)",
                "Incompetent cervix", "Placenta abruption", "Placenta previa",
                "Preeclampsia/eclampsia", "Pregnancy induced hypertension", "Rh incompatibility",
            )),
            n("Labor and Delivery Complications", topics(
                "Breech presentation", "Dystocia", "Fetal distress",
                "Premature rupture of membranes", "Preterm labor", "Prolapsed umbilical cord",
            )),
            n("Postpartum Care", topics(
                "Endometritis", "Normal physiology changes of puerperium",
                "Perineal laceration/episiotomy care", "Postpartum hemorrhage",
            )),
        ]),
    ]),
]

payload = json.dumps({"version": "v2", "nodes": curriculum}).encode()

req = urllib.request.Request(
    "http://localhost:8000/api/curriculum/import",
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
        print(f"SUCCESS: imported {result['imported']} nodes")
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f"HTTP {e.code}: {body}")
except Exception as e:
    print(f"ERROR: {e}")
