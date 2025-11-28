import { Table, Column, Model, DataType, PrimaryKey, Unique } from "sequelize-typescript";

@Table({
    tableName: "tokens",
    timestamps: true,
})
export class Token extends Model {
    @PrimaryKey
    @Unique
    @Column(DataType.STRING)
    token!: string;

    @Column({
        type: DataType.BOOLEAN,
        defaultValue: true,
    })
    isValid!: boolean;
}
